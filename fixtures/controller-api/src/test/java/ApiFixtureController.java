import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

// Standalone test fixture, never installed in the user's backend.
@RestController
public class ApiFixtureController {
    private static boolean violating;
    @GetMapping("/tags")
    public String tags() {
        return violating ? "{\"data\":[1,2,3,4]}" : "{\"data\":[1,2,3]}";
    }
    public static void main(String[] args) throws Exception {
        violating = args.length > 0 && args[0].equals("violating");
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/tags", request -> {
            byte[] body = new ApiFixtureController().tags().getBytes(StandardCharsets.UTF_8);
            request.getResponseHeaders().set("Content-Type", "application/json");
            request.sendResponseHeaders(200, body.length);
            request.getResponseBody().write(body);
            request.close();
        });
        server.start();
        System.out.println(server.getAddress().getPort());
    }
}

@interface RestController {}
@interface GetMapping { String value(); }
