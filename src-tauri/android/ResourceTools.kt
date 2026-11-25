package com.ppclash.app

import android.content.Context
import androidx.work.*
import app.tauri.plugin.JSObject
import mobile.Mobile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/** Geodata only: the embedded Go kernel is updated by installing a signed app. */
class ResourceTools(private val context: Context) {
    companion object {
        private const val JOB = "ppclash-geo-update"
        @Volatile private var application: Context? = null
        @JvmStatic external fun initializeNative(base: String)

        @JvmStatic @Synchronized fun initialize(app: Context, base: String? = null) {
            val context = app.applicationContext
            val preferences = context.getSharedPreferences("resource-runtime", Context.MODE_PRIVATE)
            val savedBase = base ?: preferences.getString("base", null) ?: context.dataDir.absolutePath
            require(File(savedBase).canonicalFile == context.dataDir.canonicalFile) { "资源目录不属于当前应用" }
            if (base != null) check(preferences.edit().putString("base", base).commit())
            application = context
            CloudTools.initialize(context, savedBase)
            initializeNative(savedBase)
        }

        private fun context(): Context = application ?: error("Android 资源任务尚未初始化")
        private fun directory(): String = File(context().dataDir, "PPClash").absolutePath

        private fun cancelSchedule() {
            Mobile.cancelGeoUpdate(directory())
            WorkManager.getInstance(context()).cancelUniqueWork(JOB)
        }

        @JvmStatic fun scheduleSaved() {
            val enabled = try { JSONObject(Mobile.geoUpdateSchedule(directory())).getBoolean("enabled") }
                catch (error: Exception) { cancelSchedule(); throw IllegalStateException("无法读取 Geo 自动更新设置", error) }
            if (!enabled) { cancelSchedule(); return }
            val request = PeriodicWorkRequestBuilder<GeoUpdateWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context()).enqueueUniquePeriodicWork(JOB, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        internal fun cancelInvalidSchedule() = cancelSchedule()
    }

    private fun dataDirectory(dir: String): String {
        val base = context.dataDir.canonicalFile
        val expected = File(base, "PPClash")
        require(File(dir).isAbsolute) { "资源目录必须是绝对路径" }
        val requested = File(dir).canonicalFile
        require(requested == expected) { "资源目录不属于当前应用" }
        require(requested.exists() || requested.mkdirs()) { "无法创建资源目录" }
        require(requested.isDirectory) { "资源目录无效" }
        return requested.path
    }

    fun listResourceFiles(dir: String): JSObject =
        JSObject().put("files", JSONArray(Mobile.listResourceFiles(dataDirectory(dir))))

    fun geoUpdateStatus(dir: String): JSObject = JSObject(Mobile.geoUpdateSchedule(dataDirectory(dir)))

    fun downloadGeoResource(
        dir: String,
        name: String,
        url: String,
        proxyUrl: String,
        mirrorPrefix: String,
    ): JSObject = JSObject().put("size", Mobile.downloadGeoResource(
        dataDirectory(dir), name, url, proxyUrl, mirrorPrefix,
    ))

    fun reinstallBundledResources(dir: String): JSObject {
        Mobile.reinstallBundledResources(dataDirectory(dir))
        return JSObject().put("message", "已重新安装内置 Geo 数据，重启内核后生效")
    }
}

class GeoUpdateWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    private val directory = File(applicationContext.dataDir, "PPClash").absolutePath

    override fun doWork(): Result {
        try {
            System.loadLibrary("ppclash_lib")
            ResourceTools.initialize(applicationContext)
        } catch (_: Exception) { return Result.retry() }
        val enabled = try { JSONObject(Mobile.geoUpdateSchedule(directory)).getBoolean("enabled") }
            catch (_: Exception) { ResourceTools.cancelInvalidSchedule(); return Result.failure() }
        if (!enabled) { ResourceTools.scheduleSaved(); return Result.success() }
        return try { Mobile.runDueGeoUpdate(directory); Result.success() }
            catch (_: Exception) { if (isStopped) Result.success() else Result.retry() }
    }

    override fun onStopped() {
        Mobile.cancelGeoUpdate(directory)
        super.onStopped()
    }
}
