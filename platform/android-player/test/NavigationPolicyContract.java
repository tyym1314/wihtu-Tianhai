import com.tianyahuyu.oasis.player.NavigationPolicy;

public final class NavigationPolicyContract {
    private static int checks;
    private static void expect(boolean actual, boolean expected, String label) {
        checks++;
        if (actual != expected) throw new AssertionError(label);
    }
    private static void rejectOrigin(String origin) {
        checks++;
        try { new NavigationPolicy(origin, "fixture_app_01"); }
        catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Unexpected origin accepted");
    }
    public static void main(String[] args) {
        NavigationPolicy policy = new NavigationPolicy("https://apk-contract.invalid", "fixture_app_01");
        if (args.length == 1 && "--back-script".equals(args[0])) {
            System.out.println(policy.backScript()); return;
        }
        String entry = policy.entryUrl();
        expect(entry.equals("https://apk-contract.invalid/player?app_id=fixture_app_01"), true, "Explicit configured entry");
        expect(policy.allowsNavigation(entry, true), true, "Player entry");
        String[] rejected = {
            null, "", "https://apk-contract.invalid/player", "https://apk-contract.invalid/player/",
            "https://apk-contract.invalid/player?app_id=wrong", entry + "&app_id=fixture_app_01",
            entry + "&external_user_id=someone", entry + "#anything", entry + "#",
            "https://apk-contract.invalid/player?app_id=%66ixture_app_01",
            "https://apk-contract.invalid/other/../player?app_id=fixture_app_01",
            "https://apk-contract.invalid/%70layer?app_id=fixture_app_01",
            "http://apk-contract.invalid/player?app_id=fixture_app_01",
            "https://apk-contract.invalid.evil.com/player?app_id=fixture_app_01",
            "https://other.invalid/player?app_id=fixture_app_01",
            "https://user@apk-contract.invalid/player?app_id=fixture_app_01",
            "https://apk-contract.invalid:443/player?app_id=fixture_app_01",
            "https://apk-contract.invalid:8443/player?app_id=fixture_app_01",
            "https://APK-CONTRACT.invalid/player?app_id=fixture_app_01",
            "https://apk-contract.invalid/demo/native/run", "https://apk-contract.invalid/api/player/session",
            "https://apk-contract.invalid/#/overview", "https://apk-contract.invalid/play/run",
            "https://apk-contract.invalid/assets/file.html", "https://apk-contract.invalid/legacy/tiger",
            "file:///player?app_id=fixture_app_01", "content://apk-contract.invalid/player?app_id=fixture_app_01",
            "javascript:alert(1)", "intent://player", "about:blank", "data:text/html,anything",
            "https://apk-contract.invalid\\@evil.com/player?app_id=fixture_app_01"
        };
        for (String value : rejected) expect(policy.allowsNavigation(value, true), false, "Top-frame boundary");
        String[] games = {"thunder","tiger","match","golf","carrom","darts","ludo","jackaroo","domino","pool","bowling","run","towerlink"};
        for (String game : games) {
            String child = "https://apk-contract.invalid/play/" + game;
            expect(policy.allowsNavigation(child, false), true, "Game iframe");
            expect(policy.allowsNavigation(child, true), false, "Game cannot replace player host");
        }
        String[] rejectedChildren = {entry, "https://evil.invalid/play/run", "http://apk-contract.invalid/play/run",
            "https://apk-contract.invalid/play/unknown", "https://apk-contract.invalid/play/run?launch_code=secret",
            "https://apk-contract.invalid/play/run#anything", "https://apk-contract.invalid/play/run/",
            "https://apk-contract.invalid/play/%72un", "https://apk-contract.invalid/play/../run",
            "https://apk-contract.invalid/demo/native/run", "https://apk-contract.invalid/api/admin/apps"};
        for (String value : rejectedChildren) expect(policy.allowsNavigation(value, false), false, "Iframe boundary");
        NavigationPolicy customPort = new NavigationPolicy("https://apk-contract.invalid:8443", "fixture_app_01");
        expect(customPort.isPlayerPage("https://apk-contract.invalid:8443/player?app_id=fixture_app_01"), true, "Explicit HTTPS port");
        expect(customPort.isPlayerPage(entry), false, "Configured port cannot be dropped");
        String[] origins = {null, "", "http://apk-contract.invalid", "https://localhost", "https://127.0.0.1",
            "https://[::1]", "https://apk-contract.invalid/", "https://apk-contract.invalid/path",
            "https://apk-contract.invalid?x=1", "https://apk-contract.invalid#fragment", "https://user@apk-contract.invalid",
            "https://APK-CONTRACT.invalid", "https://apk-contract.invalid:443", "https://apk-contract.invalid:0",
            "https://apk-contract.invalid:65536", "https://apk-contract.invalid:", "https://a..invalid", "https://-a.invalid"};
        for (String value : origins) rejectOrigin(value);
        String[] ids = {null,"","../admin","app?secret=1","app&id=1","a b","app\n"};
        for (String value : ids) {
            checks++;
            try { new NavigationPolicy("https://apk-contract.invalid", value); throw new AssertionError("Invalid App ID accepted"); }
            catch (IllegalArgumentException expected) {}
        }
        System.out.println("{\"passed\":true,\"checks\":" + checks + ",\"scope\":\"Exact origin/App ID, top frame and released iframe navigation boundaries\"}");
    }
}
