import {resolveScenario,checkDatabase} from './fixture-contract.mjs';
import {checkResponse} from './http-test-runtime.mjs';
function missingGiven(message){
 const reference=String(message).match(/\$fixture\/[\w/-]+/)?.[0];if(!reference)return null;
 return {status:'BLOCKED',failureStage:'PRECONDITION',reason:`H2 테스트 데이터 준비가 누락됐습니다: ${reference.split('/').slice(1).join('/')}.`,details:[String(message)],nextAction:'다시 검사하기를 눌러 데이터를 새로 준비해 주세요. 반복되면 실행 로그를 개발자에게 전달해 주세요.'};
}

// Keep the approved oracle and the observed response even when preparation fails.
export function h2Result(s,evidence,report){
  const base={expected:s.expected,evidence,logFile:'execution.log'};
  let result;
  try {
    result=evidence.unverified?{status:'UNVERIFIED',reason:evidence.unverified}:
      evidence.blocked?{status:'BLOCKED',reason:evidence.blocked}:
      checkResponse(resolveScenario(s,evidence),{...evidence.response,inputRejected:evidence.inputRejected,securityRejected:evidence.securityRejected});
    if(result.status==='PASS')result={...result,...checkDatabase(s,evidence)};
  } catch(error) {
    return {...base,...(missingGiven(error.message)||{status:'BLOCKED',failureStage:'PRECONDITION',reason:error.message,
      nextAction:'테스트 준비 단계에서 연관 데이터를 저장한 뒤 다시 검사해 주세요. 승인한 기대값은 바꾸지 않습니다.'})};
  }
  if(result.status==='BLOCKED'&&missingGiven(result.reason))return {...base,...missingGiven(result.reason)};
  if(evidence.fixture?.persisted&&evidence.fixture.rollbackVerified!==true)
    result={status:'BLOCKED',reason:'H2 테스트 데이터 롤백을 확인하지 못했습니다.'};
  if(result.status==='PASS'&&evidence.javaAssertionsPassed===false)
    result={status:'FAIL',reason:'생성된 Java assertion이 승인 기준과 다른 결과를 확인했습니다.'};
  if(result.status==='PASS'&&(!evidence.javaAssertionsPassed||!evidence.preconditionOk||!evidence.actionExecuted||!evidence.observationComplete||!evidence.databaseUrl?.startsWith('jdbc:h2:mem:')||![0,1].includes(report.exitCode)||report.originalUnchanged!==true))
    result={status:'BLOCKED',reason:'H2 실행 완료 근거가 부족합니다.'};
  const stage=evidence.failureStage;
  return {...base,...result,failureStage:stage,...result.status==='BLOCKED'?{
    nextAction:stage==='PRECONDITION'?'테스트 계정과 연관 데이터의 생성 오류를 확인하고 다시 검사해 주세요.':stage==='ACTION'?'실행 로그에서 요청 처리 오류를 확인하고 다시 검사해 주세요.':stage==='OBSERVATION'?'요청은 실행됐지만 DB 변경을 확인하지 못했습니다. 실행 로그의 저장·삭제 관계 오류를 개발자에게 전달해 주세요.':'인증·요청 경로와 DB 관찰 근거를 확인하고 다시 검사해 주세요.'
  }:result.status==='FAIL'?{nextAction:'아래 API 응답과 승인 기준의 차이를 개발자에게 전달해 주세요.'}:{}};
}

export function withSnapshotExpected(report,snapshot){
  if(snapshot?.specDigest!==report.specDigest)return report;
  return {...report,results:report.results.map(r=>({...r,expected:snapshot.spec.scenarios.find(s=>s.id===r.scenarioId)?.expected||r.expected||r.evidence?.expected}))};
}
