import com.tianyahuyu.oasis.player.MainActivity;
import android.view.View;
import android.webkit.*;
import android.widget.*;
import java.lang.reflect.*;

/** Runs actual Activity logic with a virtual clock and Android API substitutes. */
public final class MainActivityLifecycleContract {
    private static int checks, scenarios;
    private static void expect(boolean value, String message) {
        checks++;
        if (!value) throw new AssertionError(message);
    }
    private static Object field(MainActivity activity, String name) throws Exception {
        Field field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(activity);
    }
    private static void lifecycle(MainActivity activity, String name) throws Exception {
        Method method = MainActivity.class.getDeclaredMethod(name);
        method.setAccessible(true);
        method.invoke(activity);
    }
    private static MainActivity fresh() {
        View.reset();
        MainActivity activity = new MainActivity();
        activity.onCreate(null);
        return activity;
    }
    private static boolean failed(MainActivity activity) throws Exception {
        return (Boolean) field(activity, "pageFailed");
    }
    private static void retry(MainActivity activity) throws Exception {
        ((Button) field(activity, "retry")).performClick();
    }
    private static WebResourceRequest request(final boolean main) {
        return new WebResourceRequest() {
            public android.net.Uri getUrl() { return new android.net.Uri("https://apk-contract.invalid/player?app_id=fixture_app_01"); }
            public boolean isForMainFrame() { return main; }
        };
    }
    public static void main(String[] args) throws Exception {
        MainActivity activity = fresh();
        WebView view = WebView.latest;
        View.advance(29999);
        expect(!failed(activity), "load gets a full 30-second foreground deadline");
        View.advance(1);
        expect(failed(activity) && view.stopCalls == 1, "stalled load stops and offers retry");
        expect(((View) field(activity, "retry")).getVisibility() == View.VISIBLE && activity.finishCalls == 0, "load failure keeps Activity available");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        view.client.onPageFinished(view, view.getUrl());
        View.advance(60000);
        expect(!failed(activity) && ((View) field(activity, "status")).getVisibility() == View.GONE, "completion cancels load deadline");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        view.client.onReceivedError(view, request(false), new WebResourceError());
        expect(!failed(activity), "ordinary subresource error does not replace entire page");
        view.client.onReceivedError(view, request(true), new WebResourceError());
        View.advance(60000);
        expect(failed(activity) && view.stopCalls == 0, "network failure cancels deadline without later timeout effects");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        view.client.onReceivedHttpError(view, request(true), new WebResourceResponse());
        View.advance(60000);
        expect(failed(activity) && ((TextView) field(activity, "message")).text.contains("503"), "HTTP failure survives cancelled timeout");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        View.advance(20000); lifecycle(activity, "onPause"); View.advance(120000);
        expect(!failed(activity) && view.pauseCalls == 1, "background time does not fail loading");
        lifecycle(activity, "onResume"); View.advance(29999);
        expect(!failed(activity) && view.resumeCalls == 1, "resume starts a full foreground deadline");
        View.advance(1); expect(failed(activity), "resumed stalled load times out");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        lifecycle(activity, "onPause"); view.client.onPageFinished(view, view.getUrl());
        lifecycle(activity, "onResume"); View.advance(60000);
        expect(!failed(activity) && View.tasks.isEmpty(), "background completion does not arm a stale timeout");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        WebViewClient oldClient = view.client;
        Runnable oldTimeout = View.latestTask();
        view.client.onReceivedError(view, request(true), new WebResourceError());
        retry(activity);
        WebView replacement = WebView.latest;
        expect(replacement != view && view.destroyed && view.stopCalls == 1 && view.getParent() == null, "retry stops and removes old renderer");
        oldClient.onPageFinished(view, view.getUrl());
        oldClient.onReceivedError(view, request(true), new WebResourceError());
        oldTimeout.run();
        expect(!failed(activity) && ((View) field(activity, "status")).getVisibility() == View.VISIBLE, "old callbacks cannot hide or fail new load");
        replacement.client.onPageFinished(replacement, replacement.getUrl());
        View.advance(60000); expect(!failed(activity), "replacement completion cancels its deadline");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        view.client.onPageFinished(view, view.getUrl());
        activity.onBackPressed(); activity.onBackPressed();
        expect(view.evaluateCalls == 1, "duplicate pending Back issues only one bridge call");
        View.advance(2499); expect(activity.finishCalls == 0, "Back callback gets 2500 ms");
        View.advance(1); expect(activity.finishCalls == 1, "stalled Back closes local Activity");
        view.backCallback.onReceiveValue("\"handled\"");
        expect(activity.finishCalls == 1, "late Back callback cannot close twice");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        view.client.onPageFinished(view, view.getUrl());
        activity.onBackPressed(); view.backCallback.onReceiveValue("\"handled\"");
        View.advance(10000); expect(activity.finishCalls == 0, "handled H5 Back preserves game return authority");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        activity.onBackPressed(); view.backCallback.onReceiveValue("\"close\"");
        View.advance(10000); expect(activity.finishCalls == 1, "unhandled Back closes once");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        activity.onBackPressed();
        ValueCallback<String> previousBack = view.backCallback;
        view.client.onPageStarted(view, view.getUrl(), null);
        previousBack.onReceiveValue("\"close\"");
        View.advance(3000); expect(activity.finishCalls == 0, "new page invalidates prior Back callback and deadline");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        activity.onBackPressed(); lifecycle(activity, "onPause"); View.advance(3000);
        view.backCallback.onReceiveValue("\"close\""); lifecycle(activity, "onResume");
        expect(activity.finishCalls == 0, "background transition invalidates pending local Back");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        oldTimeout = View.latestTask();
        expect(view.client.onRenderProcessGone(view, new RenderProcessGoneDetail()), "renderer crash is handled");
        expect(failed(activity) && view.destroyed && view.getParent() == null, "crashed renderer is removed and retry remains available");
        oldTimeout.run(); retry(activity); replacement = WebView.latest;
        expect(replacement != view && !failed(activity), "crash retry owns new view and state");
        scenarios++;

        activity = fresh(); view = WebView.latest;
        activity.onBackPressed(); oldTimeout = View.tasks.get(0).runnable;
        lifecycle(activity, "onDestroy"); oldTimeout.run();
        view.backCallback.onReceiveValue("\"close\""); View.advance(60000);
        expect(view.destroyed && activity.finishCalls == 0, "destroy cancels load and invalidates Back callbacks");
        scenarios++;

        System.out.println("{\"passed\":true,\"scenarios\":" + scenarios + ",\"checks\":" + checks
                + ",\"scope\":\"Actual MainActivity callbacks with deterministic JVM Android substitutes; no device proof\"}");
    }
}
