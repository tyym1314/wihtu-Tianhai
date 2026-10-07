package com.tianyahuyu.oasis.smoke;

/** Deterministic in-process partner App fixture. It never authenticates or calls a network API. */
public final class MockPartnerApi {
    private static final String USER_ID = "mock-user-001";
    private static final String PARTNER_ID = "mock-partner-app";
    private static final String[] GAME_IDS = {
        "thunder", "tiger", "match", "golf", "carrom", "darts", "ludo",
        "jackaroo", "domino", "pool", "bowling", "run", "towerlink"
    };

    public Identity getIdentity() { return new Identity(USER_ID, PARTNER_ID); }

    public Profile getProfile(String userId) {
        requireUser(userId);
        return new Profile(USER_ID, "体验用户", 1);
    }

    public WalletBalance getWalletBalance(String userId) {
        requireUser(userId);
        // Display-only App fixture. The platform WebView uses a separate sandbox wallet.
        return new WalletBalance("TEST_COIN", 2, 100000L);
    }

    public LaunchSelection selectGame(String userId, String gameId) {
        requireUser(userId);
        if (!isSupportedGame(gameId)) throw new IllegalArgumentException("Unsupported game");
        return new LaunchSelection("mock-selection-" + gameId, gameId);
    }

    public String[] getCatalog() { return GAME_IDS.clone(); }

    private static void requireUser(String userId) {
        if (!USER_ID.equals(userId)) throw new IllegalArgumentException("Unknown mock user");
    }

    private static boolean isSupportedGame(String gameId) {
        if (gameId == null) return false;
        for (String id : GAME_IDS) if (id.equals(gameId)) return true;
        return false;
    }

    public static final class Identity {
        public final String userId;
        public final String partnerId;
        private Identity(String userId, String partnerId) {
            this.userId = userId; this.partnerId = partnerId;
        }
    }

    public static final class Profile {
        public final String userId;
        public final String displayName;
        public final int level;
        private Profile(String userId, String displayName, int level) {
            this.userId = userId; this.displayName = displayName; this.level = level;
        }
    }

    public static final class WalletBalance {
        public final String currency;
        public final int scale;
        public final long availableMinor;
        private WalletBalance(String currency, int scale, long availableMinor) {
            this.currency = currency; this.scale = scale; this.availableMinor = availableMinor;
        }
    }

    public static final class LaunchSelection {
        public final String selectionId;
        public final String gameId;
        private LaunchSelection(String selectionId, String gameId) {
            this.selectionId = selectionId; this.gameId = gameId;
        }
    }
}
