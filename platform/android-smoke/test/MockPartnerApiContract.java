import com.tianyahuyu.oasis.smoke.MockPartnerApi;
import java.util.Arrays;
import java.util.HashSet;

/** Pure JVM contract: the App fixture is repeatable and covers every released game. */
public final class MockPartnerApiContract {
    private static final String[] EXPECTED = {
        "thunder", "tiger", "match", "golf", "carrom", "darts", "ludo",
        "jackaroo", "domino", "pool", "bowling", "run", "towerlink"
    };

    public static void main(String[] args) {
        MockPartnerApi api = new MockPartnerApi();
        MockPartnerApi.Identity identity = api.getIdentity();
        equal("mock-user-001", identity.userId);
        equal("mock-partner-app", identity.partnerId);
        MockPartnerApi.Profile profile = api.getProfile(identity.userId);
        equal(identity.userId, profile.userId);
        equal("体验用户", profile.displayName);
        equal(1, profile.level);
        MockPartnerApi.WalletBalance balance = api.getWalletBalance(identity.userId);
        equal("TEST_COIN", balance.currency);
        equal(2, balance.scale);
        equal(100000L, balance.availableMinor);

        String[] catalog = api.getCatalog();
        if (!Arrays.equals(EXPECTED, catalog) || new HashSet<String>(Arrays.asList(catalog)).size() != 13) {
            throw new AssertionError("Mock launch catalogue differs from thirteen released games");
        }
        catalog[0] = "tampered";
        if (!Arrays.equals(EXPECTED, api.getCatalog())) throw new AssertionError("Catalog must be a defensive copy");
        for (String gameId : EXPECTED) {
            MockPartnerApi.LaunchSelection first = api.selectGame(identity.userId, gameId);
            MockPartnerApi.LaunchSelection second = api.selectGame(identity.userId, gameId);
            equal(gameId, first.gameId);
            equal("mock-selection-" + gameId, first.selectionId);
            equal(first.selectionId, second.selectionId);
        }
        equal(100000L, api.getWalletBalance(identity.userId).availableMinor);
        rejects(new Runnable() { public void run() { api.getProfile("other-user"); } });
        rejects(new Runnable() { public void run() { api.getWalletBalance("other-user"); } });
        rejects(new Runnable() { public void run() { api.selectGame("other-user", "run"); } });
        rejects(new Runnable() { public void run() { api.selectGame(identity.userId, "not-released"); } });
        rejects(new Runnable() { public void run() { api.selectGame(identity.userId, null); } });
        System.out.println("MockPartnerApi contract passed: deterministic identity/profile/display wallet and 13 selections");
    }

    private static void equal(Object expected, Object actual) {
        if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    private static void rejects(Runnable call) {
        try { call.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Invalid mock request was accepted");
    }
}
