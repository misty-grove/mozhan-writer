package dev.writerbench.desktop

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * 把「系统栏图标用深色还是浅色」的决定权交给网页。
   *
   * 为什么需要：开了 edge-to-edge 之后状态栏是透明的，图标画在我们的顶栏上面，
   * 而本应用有三套主题（白底 / 护眼 / 夜间），跟系统的深浅色模式各走各的。
   * 只靠 values / values-night 两份 XML 只能对上一半 —— 作者在大白天切到夜间主题时，
   * 深色图标压在深色顶栏上就看不见了。所以前端每次换主题都调一下这里。
   *
   * 前端入口见 src/platform/mobile.ts 的 syncSystemBar（App.vue 在 applyAppearance 之后调）。
   */
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(BarStyleBridge(this), "WriterBar")
  }

  private class BarStyleBridge(private val activity: MainActivity) {
    /** dark = 图标用深色（配浅色背景） */
    @JavascriptInterface
    fun setDarkIcons(dark: Boolean) {
      activity.runOnUiThread {
        WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
          isAppearanceLightStatusBars = dark
          isAppearanceLightNavigationBars = dark
        }
      }
    }
  }
}
