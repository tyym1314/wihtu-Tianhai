package com.tianyahuyu.oasis.smoke;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Native catalogue + one full-screen WebView per selected game. Debug-only host. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://game.tianyahuyu.com";
    private static final String NATIVE_PREFIX = "/demo/native/";
    private static final String RETURN_URL = ORIGIN + "/demo/native-return";
    private static final String VERSION = "1.1.1 (4)";
    private static final int BG = Color.rgb(11, 15, 24);
    private static final int TEXT = Color.rgb(244, 239, 224);
    private static final int MUTED = Color.rgb(144, 155, 176);
    private static final int GOLD = Color.rgb(220, 183, 110);
    private static final String[][] GAMES = {
        {"thunder", "雷霆王座", "THUNDER THRONE", "概率", "#405987"},
        {"tiger", "虎虎生财", "GOLDEN TIGER", "概率", "#9F6D2B"},
        {"match", "晶石对战", "MATCH ARENA", "竞技", "#7652A0"},
        {"golf", "绿洲高尔夫", "OASIS GOLF", "竞技", "#337E63"},
        {"carrom", "Carrom 弹盘", "CARROM CLUB", "竞技", "#8C6D40"},
        {"darts", "飞镖对决", "DARTS DUEL", "竞技", "#A34B66"},
        {"ludo", "Ludo 快速版", "LUDO ROYALE", "竞技", "#AA6353"},
        {"jackaroo", "Jackaroo 搭档", "JACKAROO NIGHTS", "竞技", "#416C52"},
        {"domino", "多米诺对战", "DOMINO LOUNGE", "竞技", "#466783"},
        {"pool", "八球对决", "POOL MASTERS", "竞技", "#237B79"},
        {"bowling", "保龄球对决", "BOWLING STRIKE", "竞技", "#6853A5"},
        {"run", "沙丘竞速", "DUNE DASH", "竞技", "#B28744"}
        ,{"towerlink", "连线夺塔", "TOWER LINK", "竞技", "#3B6E9F"}
    };
    private FrameLayout root;
    private WebView webView;
    private String activeGame;
    private String lastGame = "尚未启动";
    private String lastPage = "原生大厅（未加载网页）";
    private String lastError;
    private int resourceErrors;
    private int consoleErrors;
    private boolean backRequestPending;
    private boolean errorDialogVisible;
    private String appliedInsets = "等待系统安全区";

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left = 0, top = 0, right = 0, bottom = 0;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                int types = WindowInsets.Type.displayCutout() | WindowInsets.Type.ime();
                if (activeGame == null) types |= WindowInsets.Type.systemBars();
                Insets safe = insets.getInsets(types);
                left = safe.left; top = safe.top; right = safe.right; bottom = safe.bottom;
            } else if (activeGame == null) {
                left = insets.getSystemWindowInsetLeft(); top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight(); bottom = insets.getSystemWindowInsetBottom();
            } else {
                if (android.os.Build.VERSION.SDK_INT >= 28) {
                    DisplayCutout cutout = insets.getDisplayCutout();
                    if (cutout != null) {
                        left = cutout.getSafeInsetLeft(); top = cutout.getSafeInsetTop();
                        right = cutout.getSafeInsetRight(); bottom = cutout.getSafeInsetBottom();
                    }
                }
                if (insets.getSystemWindowInsetBottom() > dp(120)) bottom = Math.max(bottom, insets.getSystemWindowInsetBottom());
            }
            view.setPadding(left, top, right, bottom);
            appliedInsets = "L" + left + " T" + top + " R" + right + " B" + bottom + " px";
            return android.os.Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });
        showNativeLobby();
    }

    private void showNativeLobby() {
        destroyWebView();
        activeGame = null;
        backRequestPending = false;
        root.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setVerticalScrollBarEnabled(false);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(20), dp(21), dp(20), dp(26));
        scroll.addView(page, new ScrollView.LayoutParams(-1, -2));
        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView brand = label("O A S I S", 24, GOLD);
        brand.setTypeface(Typeface.create("serif", Typeface.BOLD));
        top.addView(brand, new LinearLayout.LayoutParams(0, dp(39), 1));
        Button diagnostics = new Button(this);
        diagnostics.setText("诊断"); diagnostics.setTextSize(11); diagnostics.setTextColor(GOLD);
        diagnostics.setMinWidth(0); diagnostics.setMinimumWidth(0); diagnostics.setPadding(0, 0, 0, 0);
        diagnostics.setBackground(rounded(Color.rgb(23, 28, 40), 12, 0x554F6179));
        diagnostics.setOnClickListener(v -> showDiagnostics());
        top.addView(diagnostics, new LinearLayout.LayoutParams(dp(54), dp(32)));
        page.addView(top);
        page.addView(label("P L A Y   C L U B   /   原生游戏大厅", 9, MUTED));
        TextView heading = label("选一款，开始精彩。", 23, TEXT);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(-1, -2);
        headingParams.setMargins(0, dp(25), 0, dp(7)); page.addView(heading, headingParams);
        LinearLayout.LayoutParams summaryParams = new LinearLayout.LayoutParams(-1, -2);
        summaryParams.setMargins(0, 0, 0, dp(20));
        page.addView(label(GAMES.length + " 款游戏  ·  独立全屏  ·  测试币体验", 11, MUTED), summaryParams);
        for (int rowIndex = 0; rowIndex < GAMES.length; rowIndex += 2) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int column = 0; column < 2 && rowIndex + column < GAMES.length; column++) {
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(155), 1);
                params.setMargins(column == 0 ? 0 : dp(7), 0, column == 0 ? dp(7) : 0, dp(14));
                row.addView(gameCard(GAMES[rowIndex + column]), params);
            }
            page.addView(row);
        }
        TextView footer = label("OASIS ANDROID  " + VERSION + "\n原生大厅 · 点击后才加载所选游戏", 10, MUTED);
        footer.setGravity(Gravity.CENTER); footer.setLineSpacing(dp(5), 1);
        footer.setPadding(0, dp(8), 0, 0); page.addView(footer);
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        applySystemBars();
    }

    private View gameCard(String[] game) {
        int tint = Color.parseColor(game[4]);
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL); card.setPadding(dp(14), dp(12), dp(12), dp(12));
        GradientDrawable surface = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{blend(tint, BG, 0.30f), Color.rgb(17, 22, 34)});
        surface.setCornerRadius(dp(19)); surface.setStroke(dp(1), blend(tint, BG, 0.58f));
        card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x22E4C386), surface, null));
        card.setElevation(dp(3)); card.setClickable(true); card.setFocusable(true);
        card.setContentDescription("game:" + game[0]);
        card.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName("android.widget.Button");
            }
        });
        card.setOnClickListener(v -> openGame(game[0]));
        LinearLayout artRow = new LinearLayout(this); artRow.setGravity(Gravity.TOP);
        ImageView icon = new ImageView(this); icon.setImageDrawable(new GameIconDrawable(game[0], tint));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        artRow.addView(icon, new LinearLayout.LayoutParams(dp(58), dp(58)));
        TextView category = label(game[3], 9, GOLD); category.setGravity(Gravity.RIGHT);
        artRow.addView(category, new LinearLayout.LayoutParams(0, dp(22), 1)); card.addView(artRow);
        TextView title = label(game[1], 14, TEXT); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setMaxLines(1); title.setSingleLine(true);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.setMargins(0, dp(12), 0, 0); card.addView(title, titleParams);
        TextView english = label(game[2], 7, MUTED); english.setLetterSpacing(0.11f);
        LinearLayout.LayoutParams englishParams = new LinearLayout.LayoutParams(-1, -2);
        englishParams.setMargins(0, dp(5), 0, 0); card.addView(english, englishParams);
        return card;
    }

    private void openGame(String id) {
        if (activeGame != null || !knownGame(id)) return;
        activeGame = id; lastGame = id; lastError = null; resourceErrors = 0; consoleErrors = 0;
        root.removeAllViews(); createWebView(); applySystemBars();
        webView.loadUrl(ORIGIN + NATIVE_PREFIX + id);
    }
    private void createWebView() {
        webView = new WebView(this); webView.setBackgroundColor(BG);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false); settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false); settings.setLoadWithOverviewMode(true); settings.setUseWideViewPort(true);
        settings.setUserAgentString(settings.getUserAgentString() + " OASISSmoke/1.1.1 NativeLobby/1");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    consoleErrors++; lastError = "页面控制台错误 " + consoleErrors + " 次";
                }
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return interceptNavigation(request.getUrl(), request.isForMainFrame());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return interceptNavigation(Uri.parse(url), true);
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                backRequestPending = false;
                if (RETURN_URL.equals(url)) { root.post(() -> showNativeLobby()); return; }
                if (!allowedNavigation(Uri.parse(url))) {
                    view.stopLoading(); lastError = "已阻止非游戏 HTTPS 页面"; return;
                }
                lastPage = safeUrl(url);
            }
            @Override public void onPageFinished(WebView view, String url) { CookieManager.getInstance().flush(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                resourceErrors++;
                lastError = "加载失败 " + error.getErrorCode() + " · " + safeUrl(request.getUrl().toString());
                if (request.isForMainFrame()) showLoadError();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                resourceErrors++;
                lastError = "HTTP " + response.getStatusCode() + " · " + safeUrl(request.getUrl().toString());
                if (request.isForMainFrame()) showLoadError();
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); lastError = "TLS 校验失败，连接已取消 · 错误 " + error.getPrimaryError(); showLoadError();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                root.removeView(view); view.destroy(); webView = null; backRequestPending = false;
                lastError = "WebView 渲染进程已退出"; showLoadError(); return true;
            }
        });
    }

    private boolean interceptNavigation(Uri uri, boolean mainFrame) {
        if (mainFrame && RETURN_URL.equals(uri.toString())) { root.post(() -> showNativeLobby()); return true; }
        if (allowedNavigation(uri)) return false;
        lastError = "已阻止非游戏 HTTPS 页面"; return true;
    }
    private boolean trustedOrigin(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && "game.tianyahuyu.com".equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }
    private boolean allowedNavigation(Uri uri) {
        if (!trustedOrigin(uri) || activeGame == null) return false;
        String path = uri.getPath();
        return (NATIVE_PREFIX + activeGame).equals(path) || ("/play/" + activeGame).equals(path)
                || path != null && (path.startsWith("/arena/") || path.startsWith("/legacy/")
                || path.startsWith("/assets/") || path.startsWith("/sdk/"));
    }
    private boolean isNativeHostPage(String value) {
        if (value == null || activeGame == null) return false;
        Uri uri = Uri.parse(value);
        return trustedOrigin(uri) && (NATIVE_PREFIX + activeGame).equals(uri.getPath());
    }
    private boolean knownGame(String id) { for (String[] game : GAMES) if (game[0].equals(id)) return true; return false; }
    private String safeUrl(String value) {
        if (value == null) return "原生大厅";
        Uri uri = Uri.parse(value);
        return (uri.getScheme() == null ? "" : uri.getScheme() + "://")
                + (uri.getHost() == null ? "" : uri.getHost()) + (uri.getPath() == null ? "" : uri.getPath());
    }

    @Override public void onBackPressed() {
        if (activeGame == null) { super.onBackPressed(); return; }
        if (backRequestPending) return;
        if (webView == null || !isNativeHostPage(webView.getUrl())) { confirmExit(); return; }
        WebView requestedView = webView; backRequestPending = true;
        String script = "(function(){try{"
                + "if(location.origin!=='https://game.tianyahuyu.com'||!/^\\/demo\\/native\\/[a-z]+$/.test(location.pathname))return 'not-handled';"
                + "if(!window.OasisNativeHost||typeof window.OasisNativeHost.requestBack!=='function')return 'not-handled';"
                + "window.OasisNativeHost.requestBack();return 'handled';"
                + "}catch(error){return 'not-handled';}})()";
        try {
            requestedView.evaluateJavascript(script, value -> {
                backRequestPending = false;
                if (isFinishing() || isDestroyed() || requestedView != webView) return;
                if (!"\"handled\"".equals(value)) confirmExit();
            });
        } catch (RuntimeException error) { backRequestPending = false; confirmExit(); }
    }
    private void confirmExit() {
        new AlertDialog.Builder(this).setTitle("返回原生大厅？")
                .setMessage("游戏暂时未响应返回请求。退出页面不能代替退赛、退款或结算；正在对局时请优先使用游戏内退出。")
                .setNegativeButton("继续游戏", null)
                .setPositiveButton("确认返回大厅", (dialog, which) -> showNativeLobby()).show();
    }
    private void showLoadError() {
        if (isFinishing() || isDestroyed() || errorDialogVisible) return;
        errorDialogVisible = true;
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("游戏连接提示")
                .setMessage(lastError + "\n\n可返回原生大厅后重试；退出页面不代表已退款或结算。")
                .setNegativeButton("留在页面", null)
                .setPositiveButton("返回原生大厅", (d, which) -> showNativeLobby()).create();
        dialog.setOnDismissListener(d -> errorDialogVisible = false); dialog.show();
    }
    private void showDiagnostics() {
        PackageInfo engine = WebView.getCurrentWebViewPackage();
        String engineLabel = engine == null ? "尚未初始化" : engine.packageName + " " + engine.versionName;
        new AlertDialog.Builder(this).setTitle("接入诊断")
                .setMessage("APK: " + VERSION + "\nAndroid: " + android.os.Build.VERSION.RELEASE
                        + " (API " + android.os.Build.VERSION.SDK_INT + ")\nWebView: " + engineLabel
                        + "\n当前视图: " + (activeGame == null ? "原生大厅，无 WebView" : "全屏游戏 " + activeGame)
                        + "\n最近游戏: " + lastGame + "\n最近页面: " + lastPage
                        + "\n系统安全区: " + appliedInsets + "\n原生容器: " + root.getWidth() + " × " + root.getHeight() + " px"
                        + "\n资源/HTTP 错误: " + resourceErrors + "\n控制台错误: " + consoleErrors
                        + "\n最近错误: " + (lastError == null ? "无" : lastError)
                        + "\n\n平台沙箱测试币；不包含合作方真实登录或主钱包。")
                .setPositiveButton("关闭", null).show();
    }

    private void applySystemBars() {
        boolean game = activeGame != null;
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (game) controller.hide(WindowInsets.Type.systemBars()); else controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (game) flags |= View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
        root.requestApplyInsets();
    }
    @Override public void onWindowFocusChanged(boolean hasFocus) { super.onWindowFocusChanged(hasFocus); if (hasFocus && root != null) applySystemBars(); }
    @Override public void onConfigurationChanged(Configuration configuration) { super.onConfigurationChanged(configuration); applySystemBars(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); if (root != null) applySystemBars(); }
    @Override protected void onPause() { if (webView != null) { CookieManager.getInstance().flush(); webView.onPause(); } super.onPause(); }
    private void destroyWebView() {
        if (webView == null) return;
        CookieManager.getInstance().flush(); WebView old = webView; webView = null;
        if (old.getParent() != null) ((ViewGroup) old.getParent()).removeView(old);
        old.stopLoading(); old.destroy();
    }
    @Override protected void onDestroy() { destroyWebView(); super.onDestroy(); }
    private TextView label(String text, int size, int color) {
        TextView label = new TextView(this); label.setText(text); label.setTextSize(size); label.setTextColor(color);
        label.setIncludeFontPadding(false); return label;
    }
    private GradientDrawable rounded(int fill, int radius, int border) {
        GradientDrawable drawable = new GradientDrawable(); drawable.setColor(fill); drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), border); return drawable;
    }
    private int blend(int color, int base, float fraction) {
        return Color.rgb(Math.round(Color.red(color) * fraction + Color.red(base) * (1 - fraction)),
                Math.round(Color.green(color) * fraction + Color.green(base) * (1 - fraction)),
                Math.round(Color.blue(color) * fraction + Color.blue(base) * (1 - fraction)));
    }
    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }
}
