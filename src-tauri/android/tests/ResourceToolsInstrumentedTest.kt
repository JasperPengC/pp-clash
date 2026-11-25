package com.ppclash.app

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.WorkManager
import mobile.Mobile
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ResourceToolsInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val dir by lazy { File(context.dataDir, "PPClash").apply { mkdirs() } }
    private var previousState: ByteArray? = null
    private var previousStatus: ByteArray? = null
    @Before fun initialize() {
        check(context.packageName.endsWith(".platformqa")) { "Only run against isolated QA data" }
        System.loadLibrary("ppclash_lib")
        previousState = File(dir, "state.json").takeIf { it.exists() }?.readBytes()
        previousStatus = File(dir, "geo-update-status.json").takeIf { it.exists() }?.readBytes()
        ResourceTools.initialize(context, context.dataDir.absolutePath)
    }
    @After fun cleanup() {
        saveSettings(false)
        ResourceTools.scheduleSaved()
        previousState?.let { File(dir, "state.json").writeBytes(it) } ?: File(dir, "state.json").delete()
        previousStatus?.let { File(dir, "geo-update-status.json").writeBytes(it) } ?: File(dir, "geo-update-status.json").delete()
    }
    private fun saveSettings(enabled: Boolean) {
        File(dir, "state.json").writeText(JSONObject().put("settings", JSONObject()
            .put("geoAutoUpdate", enabled).put("geoUpdateInterval", 2).put("geoUrls", JSONObject())).toString())
    }
    @Test fun persistedSettingsRegisterOneJobAndDisableCancelsIt() {
        saveSettings(true)
        ResourceTools.scheduleSaved()
        ResourceTools.scheduleSaved()
        val manager = WorkManager.getInstance(context)
        assertEquals(1, manager.getWorkInfosForUniqueWork("ppclash-geo-update").get().count { !it.state.isFinished })
        saveSettings(false)
        ResourceTools.scheduleSaved()
        manager.cancelUniqueWork("ppclash-geo-update").result.get()
        assertTrue(manager.getWorkInfosForUniqueWork("ppclash-geo-update").get().all { it.state.isFinished })
    }
    @Test fun coldInitializationRetainsDisabledPolicyAndDoesNotDownload() {
        saveSettings(false)
        ResourceTools.initialize(context)
        val before = JSONObject(Mobile.geoUpdateSchedule(dir.absolutePath))
        val status = JSONObject(Mobile.runDueGeoUpdate(dir.absolutePath))
        assertFalse(status.getBoolean("enabled"))
        assertEquals(2, status.getInt("intervalHours"))
        assertEquals(before.optLong("lastSuccessAt"), status.optLong("lastSuccessAt"))
        assertEquals(before.optLong("lastAttemptAt"), status.optLong("lastAttemptAt"))
    }
    @Test fun malformedSettingsCancelJobAndReportConfigurationFailure() {
        saveSettings(true)
        ResourceTools.scheduleSaved()
        File(dir, "state.json").writeText("{")
        var rejected = false
        try { ResourceTools.scheduleSaved() } catch (_: IllegalStateException) { rejected = true }
        assertTrue("Broken settings must not keep periodic retries", rejected)
        val manager = WorkManager.getInstance(context)
        manager.cancelUniqueWork("ppclash-geo-update").result.get()
        assertTrue(manager.getWorkInfosForUniqueWork("ppclash-geo-update").get().all { it.state.isFinished })
    }
}
