import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ensure } from "./domain.mjs";

const exec = promisify(execFile);
// Published at api.github.com/meta. Pinned so even the first connection cannot be intercepted.
const GITHUB_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

export function parseGithubRepository(value) {
  const match = String(value || "").trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  ensure(match, "GitHub 저장소 주소를 확인해 주세요. 예: https://github.com/팀이름/저장소이름");
  return match[1];
}
export function validBranch(value) {
  const branch = String(value || "").trim();
  ensure(/^(?!-)(?!.*\.\.)[\w./#+-]{1,200}$/.test(branch) && !branch.endsWith("/") && !branch.endsWith(".lock"), "브랜치 이름을 확인해 주세요.");
  return branch;
}
function gitError(error) {
  const text = String(error.stderr || error.message);
  if (/couldn't find remote ref/i.test(text)) return "이 브랜치를 GitHub에서 찾지 못했습니다.";
  if (/permission denied|could not read from remote|repository not found|access denied/i.test(text)) return "GitHub 저장소에 접근하지 못했습니다. 저장소 주소와 배포 키 등록을 확인해 주세요.";
  return "GitHub에서 코드를 가져오지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
}

// One server-owned copy per purpose, with a read-only key: nothing here can push to the team's repository.
// A running build keeps its own copy, so someone browsing another branch cannot change the code under it.
export class BackendCheckouts {
  constructor({ directory, remote = (repo) => `git@github.com:${repo}.git`, run = exec, workspace = process.env.BUILD_WORKSPACE }) {
    Object.assign(this, { directory, remote, run, workspace, locks: new Map(), branchLists: new Map() });
  }
  folder(projectId, purpose) {
    return purpose === "verify" && this.workspace ? path.join(this.workspace, encodeURIComponent(projectId)) : path.join(this.directory, "backends", encodeURIComponent(projectId), purpose);
  }
  keyFile(projectId) { return path.join(this.directory, "github-keys", encodeURIComponent(projectId), "id_ed25519"); }
  async publicKey(projectId) {
    const key = this.keyFile(projectId);
    if (!(await stat(key).catch(() => null))) {
      await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
      await this.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "api-check-server", "-f", key], { windowsHide: true, timeout: 30000 });
    }
    return (await readFile(`${key}.pub`, "utf8")).trim();
  }
  // Only what git and ssh need: never this server's secrets, and never an interactive prompt.
  async gitEnv(projectId) {
    const key = this.keyFile(projectId), hosts = path.join(path.dirname(key), "known_hosts");
    await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
    await writeFile(hosts, GITHUB_HOST_KEY + "\n");
    const quoted = (file) => `"${file.replaceAll("\\", "/")}"`;
    const { PATH, Path, HOME, USERPROFILE, SystemRoot, TEMP, TMP } = process.env;
    return Object.fromEntries(Object.entries({ PATH: PATH || Path, HOME, USERPROFILE, SystemRoot, TEMP, TMP, GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: `ssh -i ${quoted(key)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quoted(hosts)}` }).filter(([, v]) => v));
  }
  async git(projectId, args, cwd) {
    // A link committed to the repository stays a plain file, so reading the code cannot reach this server's keys.
    try { return (await this.run("git", ["-c", "core.autocrlf=false", "-c", "core.symlinks=false", ...args], { cwd, env: await this.gitEnv(projectId), windowsHide: true, timeout: 180000, maxBuffer: 4 * 1048576 })).stdout; }
    catch (error) { throw new Error(gitError(error), { cause: error }); }
  }
  locked(key, task) {
    const result = (this.locks.get(key) || Promise.resolve()).then(task, task);
    this.locks.set(key, result.catch(() => {}));
    return result;
  }
  async branches(project) {
    const cached = this.branchLists.get(project.id);
    if (cached && cached.repo === project.backend.repo && Date.now() - cached.at < 60000) return cached.names;
    const out = await this.git(project.id, ["ls-remote", "--heads", this.remote(project.backend.repo)]);
    const names = out.split("\n").map((line) => line.split("refs/heads/")[1]).filter(Boolean).sort();
    this.branchLists.set(project.id, { repo: project.backend.repo, names, at: Date.now() });
    return names;
  }
  // Latest commit of the branch, with leftovers of earlier runs removed. Build caches stay for speed.
  async sync(project, branch, purpose) {
    const wanted = validBranch(branch || project.backend.branch), folder = this.folder(project.id, purpose);
    // A build can rewrite its shared folder, so what git trusts (config, hooks) stays out of that folder.
    const gitDir = purpose === "verify" && this.workspace ? path.join(this.directory, "backends", encodeURIComponent(project.id), "verify.git") : null;
    const where = gitDir ? ["--git-dir", gitDir, "--work-tree", folder] : [];
    await mkdir(folder, { recursive: true });
    if (gitDir) await mkdir(gitDir, { recursive: true });
    await this.git(project.id, [...where, "init", "-q"], folder);
    await this.git(project.id, [...where, "fetch", "-q", "--depth", "1", "--no-tags", this.remote(project.backend.repo), `refs/heads/${wanted}`], folder);
    await this.git(project.id, [...where, "checkout", "-q", "--force", "--detach", "FETCH_HEAD"], folder);
    await this.git(project.id, [...where, "clean", "-q", "-ffdx", "-e", "build/", "-e", ".gradle/"], folder);
    const [commit, subject] = (await this.git(project.id, [...where, "log", "-1", "--format=%H%n%s"], folder)).trim().split("\n");
    return { repository: folder, repo: project.backend.repo, branch: wanted, commit, subject };
  }
  // For reading source: a folder connection is used as it is, a GitHub one is brought up to date first.
  withCode(project, branch, read) {
    if (project.backend.source !== "github") return read(project.backend.repository);
    const folder = this.folder(project.id, "read");
    return this.locked(folder, async () => read((await this.sync(project, branch, "read")).repository));
  }
  forVerification(project, branch) {
    return project.backend.source === "github" ? this.sync(project, branch, "verify") : null;
  }
}
