package fixture;
import org.springframework.web.bind.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import jakarta.annotation.PostConstruct;
import java.util.Map;
@RestController
public class WriteController {
  private final JdbcTemplate jdbc;
  public WriteController(JdbcTemplate jdbc){this.jdbc=jdbc;}
  @PostConstruct public void init(){jdbc.execute("create table records(id int primary key, name varchar(50))");jdbc.update("insert into records values (1,'before')");}
  @PostMapping("/records") public Map<String,Object> create(){jdbc.update("insert into records values (2,'created')");return Map.of("count", jdbc.queryForObject("select count(*) from records",Integer.class));}
  @GetMapping("/records") public Map<String,Object> read(){return Map.of("count",jdbc.queryForObject("select count(*) from records",Integer.class),"name",jdbc.queryForObject("select name from records where id=1",String.class));}
  @PatchMapping("/records") public Map<String,Object> update(){jdbc.update("update records set name='changed' where id=1");return Map.of("name",jdbc.queryForObject("select name from records where id=1",String.class));}
  @DeleteMapping("/records") public Map<String,Object> delete(){jdbc.update("delete from records");return Map.of("count",jdbc.queryForObject("select count(*) from records",Integer.class));}
  @GetMapping("/external") public Map<String,Object> external() throws Exception { new java.net.Socket("127.0.0.1",9).close();return Map.of("ok",true); }
}
