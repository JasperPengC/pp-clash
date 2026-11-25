package com.ppclash.app

import android.os.Bundle
import android.webkit.WebView
import android.view.ViewGroup
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val layout = webView.layoutParams as ViewGroup.MarginLayoutParams
            if (layout.leftMargin != safe.left || layout.topMargin != safe.top ||
                layout.rightMargin != safe.right || layout.bottomMargin != safe.bottom) {
                layout.setMargins(safe.left, safe.top, safe.right, safe.bottom)
                webView.layoutParams = layout
            }
            val imeDp = (maxOf(0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom - safe.bottom) /
                resources.displayMetrics.density).toInt()
            webView.post {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('ppclash-ime',{detail:{bottom:$imeDp}}))",
                    null,
                )
            }
            insets
        }
        ViewCompat.requestApplyInsets(window.decorView)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                isEnabled = false
                webView.evaluateJavascript("Boolean(window.ppclashAndroidBack?.())") { handled ->
                    isEnabled = true
                    if (handled != "true" && !isFinishing) moveTaskToBack(true)
                }
            }
        })
    }
}
