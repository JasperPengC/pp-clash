package com.ppclash.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.work.*
import java.io.File
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Android owns keys and background execution; Rust owns the backup format and transactions. */
object CloudTools {
    private lateinit var context: Context
    private const val KEY = "ppclash.webdav.v1"
    private const val JOB = "ppclash-webdav-backup"
    @JvmStatic external fun initializeNative(base: String, resources: String, binary: String)
    @JvmStatic external fun runBackupNative(): Int

    @JvmStatic @Synchronized fun initialize(app: Context, base: String? = null) {
        context = app.applicationContext
        val preferences = context.getSharedPreferences("cloud-runtime", Context.MODE_PRIVATE)
        if (base != null) check(preferences.edit().putString("base", base).commit())
        val savedBase = base ?: preferences.getString("base", null) ?: error("应用数据目录尚未初始化")
        val target = if (Build.SUPPORTED_ABIS.first() == "arm64-v8a") "android-arm64" else "android-x64"
        val root = File(context.filesDir, "cloud-runtime").apply { mkdirs() }
        val names = listOf("sub-store.bundle.cjs", "service-bootstrap.cjs", "build-provenance.json", "runtime-manifest.json", "$target/manifest.json", "$target/LICENSE")
        for (name in names) {
            val destination = File(root, name)
            destination.parentFile!!.mkdirs()
            // Replace from this installed APK atomically; Rust validates the manifest before use.
            val stage = File(destination.parentFile, destination.name + ".new")
            context.assets.open("ppclash-cloud/$name").use { input -> stage.outputStream().use { input.copyTo(it) } }
            check(stage.renameTo(destination)) { "无法更新内置服务资源" }
        }
        initializeNative(savedBase, root.path, File(context.applicationInfo.nativeLibraryDir, "libppclash_node.so").path)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }

    @JvmStatic @Synchronized fun credential(action: String, reference: String, value: String): String? {
        require(reference.isNotEmpty() && reference.length <= 256)
        val preferences = context.getSharedPreferences("cloud-credentials", Context.MODE_PRIVATE)
        return when (action) {
            "read" -> preferences.getString(reference, null)?.let { encoded ->
                val bytes = Base64.decode(encoded, Base64.NO_WRAP)
                require(bytes.size >= 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                cipher.updateAAD(reference.toByteArray(Charsets.UTF_8))
                String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
            }
            "write" -> {
                require(value.toByteArray(Charsets.UTF_8).size <= 65536)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key())
                cipher.updateAAD(reference.toByteArray(Charsets.UTF_8))
                val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                check(preferences.edit().putString(reference, Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
                null
            }
            "delete" -> { check(preferences.edit().remove(reference).commit()); null }
            else -> error("不支持的凭据操作")
        }
    }

    @JvmStatic fun schedule(enabled: Boolean) {
        val manager = WorkManager.getInstance(context)
        if (!enabled) { manager.cancelUniqueWork(JOB); return }
        val request = PeriodicWorkRequestBuilder<CloudBackupWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
        manager.enqueueUniquePeriodicWork(JOB, ExistingPeriodicWorkPolicy.KEEP, request)
    }
}

class CloudBackupWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result = try {
        System.loadLibrary("ppclash_lib")
        CloudTools.initialize(applicationContext)
        when (CloudTools.runBackupNative()) {
            0 -> Result.success()
            2 -> Result.failure() // Credential/configuration failure requires an explicit user retry.
            else -> Result.retry()
        }
    } catch (_: Exception) { Result.retry() }
}
