package com.ppclash.app

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.VpnService
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import mobile.Mobile
import java.io.File
import java.util.concurrent.Executors

class UpdateFileProvider : FileProvider()

@TauriPlugin
class VpnPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun initializeCloudTools(invoke: Invoke) {
        documentWorker.execute {
            try {
                CloudTools.initialize(activity, invoke.getArgs().getString("base"))
                ResourceTools.initialize(activity, invoke.getArgs().getString("base"))
                invoke.resolve(JSObject())
            } catch (_: Exception) { invoke.reject("无法初始化 Android 云工具") }
        }
    }
    @Command
    fun listResourceFiles(invoke: Invoke) {
        documentWorker.execute {
            try { invoke.resolve(ResourceTools(activity).listResourceFiles(invoke.getArgs().getString("dir"))) }
            catch (error: Exception) { invoke.reject(error.message ?: "无法读取资源列表") }
        }
    }
    @Command
    fun geoUpdateStatus(invoke: Invoke) {
        documentWorker.execute {
            try { invoke.resolve(ResourceTools(activity).geoUpdateStatus(invoke.getArgs().getString("dir"))) }
            catch (error: Exception) { invoke.reject(error.message ?: "无法读取资源更新任务") }
        }
    }
    @Command
    fun downloadGeoResource(invoke: Invoke) {
        documentWorker.execute {
            try {
                val args = invoke.getArgs()
                invoke.resolve(ResourceTools(activity).downloadGeoResource(args.getString("dir"), args.getString("name"),
                    args.getString("url"), args.optString("proxyUrl"), args.optString("mirrorPrefix")))
            } catch (error: Exception) { invoke.reject(error.message ?: "无法更新数据库") }
        }
    }
    @Command
    fun reinstallBundledResources(invoke: Invoke) {
        documentWorker.execute {
            try { invoke.resolve(ResourceTools(activity).reinstallBundledResources(invoke.getArgs().getString("dir"))) }
            catch (error: Exception) { invoke.reject(error.message ?: "无法恢复内置数据库") }
        }
    }
    @Command
    fun setSystemTheme(invoke: Invoke) = activity.runOnUiThread {
        val light = invoke.getArgs().optBoolean("light")
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }
        invoke.resolve(JSObject())
    }

    @Suppress("DEPRECATION")
    @Command
    fun appInfo(invoke: Invoke) {
        val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
        invoke.resolve(JSObject().put("version", info.versionName)
            .put("build", if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong())
            .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            .put("kernelVersion", Mobile.version())
            .put("debug", activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0))
    }

    @Command
    fun openExternal(invoke: Invoke) = activity.runOnUiThread {
        try {
            val uri = Uri.parse(invoke.getArgs().optString("url"))
            require(uri.scheme in setOf("https", "http") && !uri.host.isNullOrBlank()) { "链接无效" }
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            invoke.resolve(JSObject())
        } catch (error: Exception) { invoke.reject(error.message ?: "无法打开链接") }
    }

    @Suppress("DEPRECATION")
    @Command
    fun openUpdate(invoke: Invoke) {
        documentWorker.execute {
            try {
                val file = File(invoke.getArgs().optString("path")).canonicalFile
                val expected = File(activity.cacheDir, "updates/update.apk").canonicalFile
                require(file == expected && file.isFile) { "安装包不在更新目录，请重新下载" }
                val manager = activity.packageManager
                val archive = manager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNATURES)
                    ?: error("无法读取 Android 安装包")
                val installed = manager.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
                require(archive.packageName == activity.packageName) { "安装包不属于 PP Clash" }
                val signatures = archive.signatures?.map { it.toCharsString() }?.toSet().orEmpty()
                require(signatures.isNotEmpty() && signatures == installed.signatures?.map { it.toCharsString() }?.toSet()) {
                    "安装包签名与当前应用不同，请使用同一发布渠道的安装包"
                }
                val archiveCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
                val installedCode = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
                require(archiveCode >= installedCode) { "安装包比当前版本旧" }
                activity.runOnUiThread {
                    try {
                        if (Build.VERSION.SDK_INT >= 26 && !manager.canRequestPackageInstalls()) {
                            startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:${activity.packageName}")), "installPermissionResult")
                        } else {
                            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
                            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                            invoke.resolve(JSObject())
                        }
                    } catch (error: Exception) { invoke.reject(error.message ?: "无法打开系统安装器") }
                }
            } catch (error: Exception) { invoke.reject(error.message ?: "安装包无效") }
        }
    }

    @ActivityCallback
    fun installPermissionResult(invoke: Invoke, result: ActivityResult) {
        if (Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()) openUpdate(invoke)
        else invoke.reject("未允许安装应用，可在系统设置中授权后重试")
    }

    @Command
    fun readDocument(invoke: Invoke) = readOrWriteDocument(invoke) { uri ->
        val filename = activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
        if (filename?.substringAfterLast('.')?.lowercase() !in setOf("yaml", "yml", "json")) {
            error("仅支持 .yaml / .yml / .json 文件")
        }
        val bytes = activity.contentResolver.openInputStream(uri)?.use { input ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > 10 * 1024 * 1024) error("订阅文件超过 10 MB")
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: error("无法打开订阅文件")
        val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        if (text.isBlank()) error("文件是空的")
        JSObject().put("text", text)
    }

    @Command
    fun writeDocument(invoke: Invoke) = readOrWriteDocument(invoke) { uri ->
        val bytes = invoke.getArgs().getString("content")?.toByteArray(Charsets.UTF_8)
            ?: error("日志内容为空")
        if (bytes.size > 20 * 1024 * 1024) error("日志超过 20 MB，无法导出")
        activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
            ?: error("无法打开导出文件")
        JSObject()
    }

    private fun readOrWriteDocument(invoke: Invoke, operation: (Uri) -> JSObject) {
        val uri = Uri.parse(invoke.getArgs().optString("uri"))
        if (uri.scheme != "content") {
            invoke.reject("请选择系统文件选择器中的文件")
            return
        }
        documentWorker.execute {
            try { invoke.resolve(operation(uri)) }
            catch (error: Exception) { invoke.reject(error.message ?: "无法访问所选文件") }
        }
    }

    @Command
    fun startVpn(invoke: Invoke) = activity.runOnUiThread {
        try {
            val permission = VpnService.prepare(activity)
            if (permission != null) {
                startActivityForResult(invoke, permission, "vpnPermissionResult")
            } else {
                connect(invoke)
            }
        } catch (exception: Exception) {
            invoke.reject(exception.message ?: "无法请求 VPN 权限")
        }
    }

    @ActivityCallback
    fun vpnPermissionResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK && VpnService.prepare(activity) == null) {
            connect(invoke)
        } else {
            invoke.reject("未授权 VPN，请允许系统连接后重试")
        }
    }

    private fun connect(invoke: Invoke) {
        val path = invoke.getArgs().getString("path")
        if (path.isNullOrEmpty()) {
            invoke.reject("找不到 VPN 配置")
            return
        }
        ClashVpnService.connect(activity, path, invoke)
    }

    @Command
    fun stopVpn(invoke: Invoke) = activity.runOnUiThread {
        ClashVpnService.disconnect(invoke)
    }

    @Command
    fun vpnStatus(invoke: Invoke) {
        invoke.resolve(ClashVpnService.status())
    }

    @Command
    fun validateConfig(invoke: Invoke) {
        val path = invoke.getArgs().getString("path")
        if (path.isNullOrEmpty()) {
            invoke.reject("找不到 VPN 配置")
            return
        }
        ClashVpnService.worker.execute {
            try {
                Mobile.validate(path)
                invoke.resolve(JSObject())
            } catch (error: Throwable) {
                invoke.reject(error.message ?: "mihomo 配置校验失败")
            }
        }
    }

    @Command
    fun readLog(invoke: Invoke) {
        invoke.resolve(JSObject().put("text", Mobile.logs(invoke.getArgs().optInt("lines", 400))))
    }

    private companion object {
        val documentWorker = Executors.newSingleThreadExecutor()
    }
}
