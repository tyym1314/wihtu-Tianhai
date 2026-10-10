import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {ROOT} from '../build-config.mjs';

// Compile the real Activity against API substitutes, then exercise callbacks with a
// virtual clock. This proves native control flow, not renderer or physical-device behavior.
const directory=path.join(ROOT,'build','activity-contracts');
await rm(directory,{recursive:true,force:true});
await mkdir(path.join(directory,'classes'),{recursive:true});
const sources={
 'android/os/Bundle.java':'package android.os; public class Bundle {}',
 'android/os/Message.java':'package android.os; public class Message {}',
 'android/os/Build.java':'package android.os; public class Build { public static class VERSION { public static int SDK_INT=35; }}',
 'android/content/pm/ApplicationInfo.java':'package android.content.pm; public class ApplicationInfo { public static final int FLAG_DEBUGGABLE=2; public int flags=2; }',
 'android/content/res/Configuration.java':'package android.content.res; public class Configuration {}',
 'android/content/res/Resources.java':'package android.content.res; public class Resources { public static class Metrics { public float density=1; } public Metrics getDisplayMetrics(){return new Metrics();}}',
 'android/graphics/Color.java':'package android.graphics; public class Color { public static final int WHITE=-1; public static int rgb(int r,int g,int b){return r<<16|g<<8|b;} }',
 'android/graphics/Bitmap.java':'package android.graphics; public class Bitmap {}',
 'android/graphics/Insets.java':'package android.graphics; public class Insets { public int left,top,right,bottom; }',
 'android/net/Uri.java':'package android.net; public class Uri { private final String url; public Uri(String value){url=value;} public String toString(){return url;} }',
 'android/net/http/SslError.java':'package android.net.http; public class SslError {}',
 'android/view/Gravity.java':'package android.view; public class Gravity { public static final int CENTER=17; }',
 'android/view/WindowInsets.java':[
  'package android.view; public class WindowInsets {',
  'public static final WindowInsets CONSUMED=new WindowInsets();',
  'public static class Type { public static int systemBars(){return 1;} public static int displayCutout(){return 2;} public static int ime(){return 4;} }',
  'public android.graphics.Insets getInsets(int mask){return new android.graphics.Insets();}',
  'public int getSystemWindowInsetLeft(){return 0;} public int getSystemWindowInsetTop(){return 0;}',
  'public int getSystemWindowInsetRight(){return 0;} public int getSystemWindowInsetBottom(){return 0;}',
  'public WindowInsets consumeSystemWindowInsets(){return this;} }'
 ].join('\n'),
 'android/view/View.java':[
  'package android.view; import java.util.*; public class View {',
  'public static final int VISIBLE=0,GONE=8,SYSTEM_UI_FLAG_LAYOUT_STABLE=1,SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN=2,SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION=4;',
  'public interface Click { void run(View view); } public interface InsetsListener { WindowInsets run(View view,WindowInsets insets); }',
  'public static long now; public static final List<Task> tasks=new ArrayList<>();',
  'public static class Task { public final Runnable runnable; final View owner; final long at; Task(Runnable r,View v,long t){runnable=r;owner=v;at=t;} }',
  'public static void reset(){now=0;tasks.clear();}',
  'public static void advance(long ms){long end=now+ms;while(true){Task next=null;for(Task task:tasks)if(task.at<=end&&(next==null||task.at<next.at))next=task;if(next==null)break;tasks.remove(next);now=next.at;next.runnable.run();}now=end;}',
  'public static Runnable latestTask(){return tasks.get(tasks.size()-1).runnable;}',
  'private int visibility=VISIBLE; private Click click; public ViewGroup parent;',
  'public View(){} public View(Object context){} public void setBackgroundColor(int value){} public void setSystemUiVisibility(int value){}',
  'public void setOnApplyWindowInsetsListener(InsetsListener value){} public void requestApplyInsets(){} public void setPadding(int a,int b,int c,int d){}',
  'public void setVisibility(int value){visibility=value;} public int getVisibility(){return visibility;}',
  'public void setOnClickListener(Click value){click=value;} public void performClick(){click.run(this);}',
  'public boolean postDelayed(Runnable value,long ms){tasks.add(new Task(value,this,now+ms));return true;}',
  'public boolean removeCallbacks(Runnable value){return tasks.removeIf(task->task.owner==this&&task.runnable==value);}',
  'public Object getParent(){return parent;} }'
 ].join('\n'),
 'android/view/ViewGroup.java':[
  'package android.view; public class ViewGroup extends View {',
  'public ViewGroup(Object context){super(context);} public void addView(View child){child.parent=this;}',
  'public void addView(View child,Object layout){addView(child);} public void addView(View child,int index,Object layout){addView(child);}',
  'public void removeView(View child){child.parent=null;} }'
 ].join('\n'),
 'android/view/Window.java':'package android.view; public class Window { public void setStatusBarColor(int value){} public void setNavigationBarColor(int value){} public void setDecorFitsSystemWindows(boolean value){} public View getDecorView(){return new View();} }',
 'android/app/Activity.java':[
  'package android.app; public class Activity {',
  'public int finishCalls; private boolean destroyed;',
  'public void onCreate(android.os.Bundle state){} public void onBackPressed(){} protected void onPause(){} protected void onResume(){}',
  'protected void onDestroy(){destroyed=true;} public void onConfigurationChanged(android.content.res.Configuration value){}',
  'public boolean isFinishing(){return finishCalls>0;} public boolean isDestroyed(){return destroyed;} public void finish(){finishCalls++;}',
  'public android.view.Window getWindow(){return new android.view.Window();} public void setContentView(android.view.View value){}',
  'public android.content.res.Resources getResources(){return new android.content.res.Resources();}',
  'public android.content.pm.ApplicationInfo getApplicationInfo(){return new android.content.pm.ApplicationInfo();} }'
 ].join('\n'),
 'android/widget/FrameLayout.java':'package android.widget; public class FrameLayout extends android.view.ViewGroup { public FrameLayout(Object context){super(context);} public static class LayoutParams { public LayoutParams(int a,int b){} }}',
 'android/widget/LinearLayout.java':'package android.widget; public class LinearLayout extends android.view.ViewGroup { public static final int VERTICAL=1; public LinearLayout(Object context){super(context);} public void setOrientation(int value){} public void setGravity(int value){} }',
 'android/widget/ProgressBar.java':'package android.widget; public class ProgressBar extends android.view.View { public ProgressBar(Object context){super(context);} }',
 'android/widget/TextView.java':'package android.widget; public class TextView extends android.view.View { public String text; public TextView(Object context){super(context);} public void setText(String value){text=value;} public void setTextColor(int value){} public void setTextSize(int value){} public void setGravity(int value){} }',
 'android/widget/Button.java':'package android.widget; public class Button extends TextView { public Button(Object context){super(context);} }',
 'android/webkit/ValueCallback.java':'package android.webkit; public interface ValueCallback<T> { void onReceiveValue(T value); }',
 'android/webkit/CookieManager.java':'package android.webkit; public class CookieManager { private static final CookieManager INSTANCE=new CookieManager(); public static CookieManager getInstance(){return INSTANCE;} public void setAcceptCookie(boolean value){} public void setAcceptThirdPartyCookies(WebView view,boolean value){} public void flush(){} }',
 'android/webkit/PermissionRequest.java':'package android.webkit; public class PermissionRequest { public void deny(){} }',
 'android/webkit/RenderProcessGoneDetail.java':'package android.webkit; public class RenderProcessGoneDetail {}',
 'android/webkit/SslErrorHandler.java':'package android.webkit; public class SslErrorHandler { public void cancel(){} }',
 'android/webkit/WebResourceError.java':'package android.webkit; public class WebResourceError {}',
 'android/webkit/WebResourceRequest.java':'package android.webkit; public interface WebResourceRequest { android.net.Uri getUrl(); boolean isForMainFrame(); }',
 'android/webkit/WebResourceResponse.java':'package android.webkit; public class WebResourceResponse { public int getStatusCode(){return 503;} }',
 'android/webkit/WebChromeClient.java':'package android.webkit; public class WebChromeClient { public void onPermissionRequest(PermissionRequest request){} public boolean onCreateWindow(WebView current,boolean dialog,boolean gesture,android.os.Message result){return false;} }',
 'android/webkit/WebSettings.java':[
  'package android.webkit; public class WebSettings { public static final int MIXED_CONTENT_NEVER_ALLOW=1,LOAD_DEFAULT=0;',
  ...['JavaScriptEnabled','DomStorageEnabled','AllowFileAccess','AllowContentAccess','AllowFileAccessFromFileURLs','AllowUniversalAccessFromFileURLs','SafeBrowsingEnabled','JavaScriptCanOpenWindowsAutomatically','SupportMultipleWindows','GeolocationEnabled','MediaPlaybackRequiresUserGesture','SupportZoom','LoadWithOverviewMode','UseWideViewPort'].map(name=>'public void set'+name+'(boolean value){}'),
  'public void setMixedContentMode(int value){} public void setCacheMode(int value){} public void setUserAgentString(String value){} public String getUserAgentString(){return "test";} }'
 ].join('\n'),
 'android/webkit/WebViewClient.java':[
  'package android.webkit; public class WebViewClient {',
  'public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return false;} public boolean shouldOverrideUrlLoading(WebView view,String url){return false;}',
  'public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){} public void onPageFinished(WebView view,String url){}',
  'public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){}',
  'public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response){}',
  'public void onReceivedSslError(WebView view,SslErrorHandler handler,android.net.http.SslError error){}',
  'public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){return false;} }'
 ].join('\n'),
 'android/webkit/WebView.java':[
  'package android.webkit; public class WebView extends android.view.View {',
  'public static WebView latest; public WebViewClient client; public ValueCallback<String> backCallback;',
  'public int stopCalls,evaluateCalls,pauseCalls,resumeCalls; public boolean destroyed; private String url;',
  'public WebView(Object context){super(context);latest=this;} public static void setWebContentsDebuggingEnabled(boolean value){}',
  'public WebSettings getSettings(){return new WebSettings();} public void setWebChromeClient(WebChromeClient value){}',
  'public void setWebViewClient(WebViewClient value){client=value;} public void loadUrl(String value){url=value;}',
  'public String getUrl(){return url;} public void stopLoading(){stopCalls++;} public void destroy(){destroyed=true;}',
  'public void onPause(){pauseCalls++;} public void onResume(){resumeCalls++;}',
  'public void evaluateJavascript(String script,ValueCallback<String> callback){evaluateCalls++;backCallback=callback;} }'
 ].join('\n'),
 'com/tianyahuyu/oasis/player/PlayerBuildConfig.java':[
  'package com.tianyahuyu.oasis.player; public class PlayerBuildConfig {',
  'public static final String PUBLIC_ORIGIN="https://apk-contract.invalid",PUBLIC_APP_ID="fixture_app_01",VERSION="test";',
  'public static final boolean QA=true,CONTRACT_FIXTURE=false; }'
 ].join('\n')
};
const files=[];
for(const [name,source] of Object.entries(sources)){
 const file=path.join(directory,name);
 await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source+'\n');files.push(file);
}
const java=process.env.OASIS_JAVA_HOME||'/Applications/Android Studio.app/Contents/jbr/Contents/Home';
const app=path.join(ROOT,'app/src/com/tianyahuyu/oasis/player');
try{
 execFileSync(path.join(java,'bin/javac'),['-encoding','UTF-8','--release','8','-Xlint:-options','-d',path.join(directory,'classes'),...files,
  path.join(ROOT,'test/MainActivityLifecycleContract.java'),path.join(app,'MainActivity.java'),path.join(app,'NavigationPolicy.java')],{stdio:['ignore','pipe','pipe']});
 const result=JSON.parse(execFileSync(path.join(java,'bin/java'),['-cp',path.join(directory,'classes'),'MainActivityLifecycleContract'],{encoding:'utf8'}));
 assert.equal(result.passed,true);assert.ok(result.scenarios>=14);assert.ok(result.checks>=24);
 console.log(JSON.stringify(result));
}catch(error){if(error.stderr)process.stderr.write(error.stderr);throw error;}
