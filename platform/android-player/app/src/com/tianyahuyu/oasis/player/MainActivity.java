package com.tianyahuyu.oasis.player;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
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
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** A server-authenticated player shell, without client-side identity or wallet fixtures. */
public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(15, 22, 33);
    private static final long LOAD_TIMEOUT_MS = 30000;
    private NavigationPolicy policy;
    private FrameLayout root;
    private WebView webView;
    private LinearLayout status;
    private TextView message;
    private ProgressBar progress;
    private Button retry;
    private boolean pageFailed;
    private boolean pageLoading;
    private boolean paused;
    private boolean backPending;
    private int backGeneration;
    private int loadGeneration;
    private Runnable loadTimeout;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Build configuration is public. No Intent extra can replace the configured App or origin.
        policy = new NavigationPolicy(PlayerBuildConfig.PUBLIC_ORIGIN, PlayerBuildConfig.PUBLIC_APP_ID);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        setContentView(root);
        createStatus();
        loadPlayer();
        root.requestApplyInsets();
    }

    private void createStatus() {
        status = new LinearLayout(this);
        status.setOrientation(LinearLayout.VERTICAL);
        status.setGravity(Gravity.CENTER);
        status.setBackgroundColor(BG);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        status.setPadding(padding, padding, padding, padding);
        progress = new ProgressBar(this);
        status.addView(progress);
        message = new TextView(this);
        message.setTextColor(Color.WHITE);
        message.setTextSize(17);
        message.setGravity(Gravity.CENTER);
        message.setPadding(0, padding, 0, padding);
        status.addView(message);
        retry = new Button(this);
        retry.setText("重试连接");
        retry.setOnClickListener(view -> loadPlayer());
        status.addView(retry);
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));
    }

    private void createWebView() {
        WebView view = new WebView(this);
        webView = view;
        view.setBackgroundColor(BG);
        root.addView(view, 0, new FrameLayout.LayoutParams(-1, -1));
        boolean debug = PlayerBuildConfig.QA && (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debug);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " OASISPlayer/" + PlayerBuildConfig.VERSION
                + (PlayerBuildConfig.QA ? " QA/1" : " Release/1"));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onCreateWindow(WebView current, boolean dialog, boolean gesture, android.os.Message result) { return false; }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView current, WebResourceRequest request) {
                return !policy.allowsNavigation(request.getUrl().toString(), request.isForMainFrame());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView current, String url) {
                return !policy.allowsNavigation(url, true);
            }
            @Override public void onPageStarted(WebView current, String url, android.graphics.Bitmap icon) {
                if (current != webView) return;
                clearBackRequest();
                if (!policy.isPlayerPage(url)) {
                    current.stopLoading();
                    showFailure("已阻止非授权页面。请重新打开游戏大厅。");
                } else {
                    pageLoading = true;
                    armLoadTimeout();
                }
            }
            @Override public void onPageFinished(WebView current, String url) {
                if (current != webView) return;
                pageLoading = false;
                cancelLoadTimeout();
                CookieManager.getInstance().flush();
                if (!pageFailed && policy.isPlayerPage(url)) status.setVisibility(View.GONE);
            }
            @Override public void onReceivedError(WebView current, WebResourceRequest request, WebResourceError error) {
                if (current == webView && request.isForMainFrame()) showFailure("网络连接失败。请检查网络后重试。");
            }
            @Override public void onReceivedHttpError(WebView current, WebResourceRequest request, WebResourceResponse response) {
                if (current == webView && request.isForMainFrame()) showFailure("游戏服务暂不可用（HTTP " + response.getStatusCode() + "）。请稍后重试。");
            }
            @Override public void onReceivedSslError(WebView current, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                if (current == webView) showFailure("安全连接校验失败，连接已取消。请稍后重试。");
            }
            @Override public boolean onRenderProcessGone(WebView current, RenderProcessGoneDetail detail) {
                if (current == webView) {
                    destroyWebView(true);
                    showFailure("游戏画面连接已中断。重试将读取服务器上的账号和对局状态。");
                } else current.destroy();
                return true;
            }
        });
        if (paused) view.onPause();
    }

    private void loadPlayer() {
        if (isFinishing() || isDestroyed()) return;
        // A retry owns a fresh view so callbacks from the stopped load cannot hide its status.
        destroyWebView(false);
        pageFailed = false;
        pageLoading = true;
        message.setText(PlayerBuildConfig.CONTRACT_FIXTURE
                ? "合约验证包：不连接真实游戏服务" : "正在连接游戏大厅…");
        progress.setVisibility(View.VISIBLE);
        retry.setVisibility(View.GONE);
        status.setVisibility(View.VISIBLE);
        if (webView == null) createWebView();
        webView.loadUrl(policy.entryUrl());
        armLoadTimeout();
    }

    private void showFailure(String text) {
        if (isFinishing() || isDestroyed()) return;
        pageFailed = true;
        pageLoading = false;
        cancelLoadTimeout();
        clearBackRequest();
        message.setText(PlayerBuildConfig.CONTRACT_FIXTURE ? "合约验证包：无真实后端连接\n" + text : text);
        progress.setVisibility(View.GONE);
        retry.setVisibility(View.VISIBLE);
        status.setVisibility(View.VISIBLE);
    }

    private void cancelLoadTimeout() {
        loadGeneration++;
        if (loadTimeout != null && root != null) root.removeCallbacks(loadTimeout);
        loadTimeout = null;
    }

    private void armLoadTimeout() {
        cancelLoadTimeout();
        if (!pageLoading || paused || webView == null || isFinishing() || isDestroyed()) return;
        final WebView requested = webView;
        final int generation = loadGeneration;
        loadTimeout = () -> {
            if (generation != loadGeneration || requested != webView || !pageLoading || paused
                    || isFinishing() || isDestroyed()) return;
            requested.stopLoading();
            showFailure("连接等待时间过长。请检查网络后重试。");
        };
        root.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
    }

    @Override public void onBackPressed() {
        if (webView == null || !policy.isPlayerPage(webView.getUrl())) { finish(); return; }
        if (backPending) return;
        final WebView requested = webView;
        backPending = true;
        final int generation = ++backGeneration;
        // A stalled renderer must not trap the user. This only closes the local Activity.
        root.postDelayed(() -> {
            if (generation == backGeneration && backPending && requested == webView
                    && !isFinishing() && !isDestroyed()) { clearBackRequest(); finish(); }
        }, 2500);
        try {
            requested.evaluateJavascript(policy.backScript(), value -> {
                if (isFinishing() || isDestroyed() || requested != webView || generation != backGeneration) return;
                clearBackRequest();
                if (!"\"handled\"".equals(value)) finish();
            });
        } catch (RuntimeException error) { clearBackRequest(); finish(); }
    }

    private void clearBackRequest() { backPending = false; backGeneration++; }

    @Override protected void onPause() {
        paused = true;
        cancelLoadTimeout();
        clearBackRequest();
        if (webView != null) { CookieManager.getInstance().flush(); webView.onPause(); }
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        paused = false;
        if (webView != null) webView.onResume();
        if (pageLoading) armLoadTimeout();
        if (root != null) root.requestApplyInsets();
    }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (root != null) root.requestApplyInsets();
    }
    private void destroyWebView(boolean rendererGone) {
        pageLoading = false;
        cancelLoadTimeout();
        clearBackRequest();
        WebView old = webView;
        webView = null;
        if (old == null) return;
        CookieManager.getInstance().flush();
        if (old.getParent() != null) ((ViewGroup) old.getParent()).removeView(old);
        if (!rendererGone) {
            old.stopLoading();
            old.setWebChromeClient(null);
            old.setWebViewClient(new WebViewClient());
        }
        old.destroy();
    }
    @Override protected void onDestroy() { destroyWebView(false); super.onDestroy(); }
}
