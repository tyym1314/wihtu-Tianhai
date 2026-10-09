package com.tianyahuyu.oasis.player;

import java.net.URI;
import java.net.URISyntaxException;

/** Presentation navigation only. Authentication and game authority stay on the server. */
public final class NavigationPolicy {
    private final String origin;
    private final String appId;
    private final URI originUri;

    public NavigationPolicy(String publicOrigin, String publicAppId) {
        if (publicOrigin == null || publicAppId == null || !publicAppId.matches("[-A-Za-z0-9_]{1,128}")) {
            throw new IllegalArgumentException("Explicit public origin and App ID required");
        }
        URI parsed = parse(publicOrigin);
        if (parsed == null || !"https".equals(parsed.getScheme()) || parsed.getHost() == null
                || !parsed.getHost().matches("[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?")
                || parsed.getHost().indexOf('.') < 0 || parsed.getHost().matches("[0-9.]+")
                || parsed.getHost().endsWith(".localhost") || parsed.getHost().endsWith(".local")
                || parsed.getHost().endsWith(".internal") || !validDnsLabels(parsed.getHost()) || parsed.getUserInfo() != null
                || !"".equals(parsed.getRawPath()) || parsed.getRawQuery() != null
                || parsed.getRawFragment() != null || parsed.getPort() == 443
                || parsed.getPort() == 0 || parsed.getPort() > 65535
                || !publicOrigin.equals("https://" + parsed.getHost() + (parsed.getPort() == -1 ? "" : ":" + parsed.getPort()))) {
            throw new IllegalArgumentException("Canonical exact HTTPS origin required");
        }
        origin = publicOrigin;
        appId = publicAppId;
        originUri = parsed;
    }

    public String entryUrl() { return origin + "/player?app_id=" + appId; }

    public boolean isTrustedOrigin(String value) {
        URI uri = parse(value);
        return uri != null && "https".equals(uri.getScheme()) && uri.getUserInfo() == null
                && originUri.getHost().equals(uri.getHost()) && originUri.getPort() == uri.getPort();
    }

    public boolean isPlayerPage(String value) {
        URI uri = parse(value);
        return uri != null && isTrustedOrigin(value) && "/player".equals(uri.getRawPath())
                && ("app_id=" + appId).equals(uri.getRawQuery()) && uri.getRawFragment() == null;
    }

    public boolean allowsNavigation(String value, boolean mainFrame) {
        if (mainFrame) return isPlayerPage(value);
        URI uri = parse(value);
        if (uri == null || !isTrustedOrigin(value) || uri.getRawQuery() != null || uri.getRawFragment() != null) return false;
        String path = uri.getRawPath();
        return path != null && path.matches("/play/(thunder|tiger|match|golf|carrom|darts|ludo|jackaroo|domino|pool|bowling|run|towerlink)");
    }

    /** Invoked only after native validation of the current top-level player URL. */
    public String backScript() {
        return "(function(){try{"
                + "if(window!==window.top||location.origin!== '" + origin + "'||location.pathname!=='/player'||location.hash)return 'close';"
                + "if(location.search!=='?app_id=" + appId + "')return 'close';"
                + "if(!window.OasisPlayerHost||typeof window.OasisPlayerHost.requestBack!=='function')return 'close';"
                + "return window.OasisPlayerHost.requestBack()===true?'handled':'close';"
                + "}catch(error){return 'close';}})()";
    }

    private static URI parse(String value) {
        if (value == null) return null;
        try { return new URI(value); }
        catch (URISyntaxException error) { return null; }
    }

    private static boolean validDnsLabels(String host) {
        if (host.length() > 253) return false;
        for (String label : host.split("\\.", -1)) {
            if (!label.matches("([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])")) return false;
        }
        return true;
    }
}
