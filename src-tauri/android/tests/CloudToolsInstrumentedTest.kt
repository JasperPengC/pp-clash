package com.ppclash.app

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.WorkManager
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloudToolsInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val reference = "qa-credential"
    private val secondReference = "qa-second-credential"

    @Before fun initialize() {
        check(context.packageName.endsWith(".platformqa")) { "Only run against isolated QA data" }
        System.loadLibrary("ppclash_lib")
        CloudTools.initialize(context, context.dataDir.absolutePath)
        CloudTools.credential("delete", reference, "")
        CloudTools.credential("delete", secondReference, "")
    }
    @After fun cleanup() {
        CloudTools.credential("delete", reference, "")
        CloudTools.credential("delete", secondReference, "")
        CloudTools.schedule(false)
    }
    @Test fun keystoreRoundTripReplacementAndDeletion() {
        assertNull(CloudTools.credential("read", reference, ""))
        CloudTools.credential("write", reference, "测试 passphrase ①")
        assertEquals("测试 passphrase ①", CloudTools.credential("read", reference, ""))
        val encrypted = context.getSharedPreferences("cloud-credentials", Context.MODE_PRIVATE).getString(reference, null)!!
        assertFalse(encrypted.contains("passphrase"))
        CloudTools.initialize(context) // Existing persisted key and ciphertext must remain readable.
        assertEquals("测试 passphrase ①", CloudTools.credential("read", reference, ""))
        CloudTools.credential("write", reference, "replacement")
        assertEquals("replacement", CloudTools.credential("read", reference, ""))
        CloudTools.credential("delete", reference, "")
        assertNull(CloudTools.credential("read", reference, ""))
    }
    @Test fun corruptedOrReassignedCiphertextCannotBeRead() {
        CloudTools.credential("write", reference, "secret")
        val preferences = context.getSharedPreferences("cloud-credentials", Context.MODE_PRIVATE)
        val encrypted = preferences.getString(reference, null)!!
        check(preferences.edit().putString(secondReference, encrypted).commit())
        assertReadFails(secondReference)
        check(preferences.edit().putString(reference, "AAAA").commit())
        assertReadFails(reference)
    }
    private fun assertReadFails(name: String) {
        var failed = false
        try { CloudTools.credential("read", name, "") } catch (_: Exception) { failed = true }
        assertTrue("Invalid ciphertext must be rejected", failed)
    }
    @Test fun backgroundRegistrationIsUniqueAndCanBeCancelled() {
        CloudTools.schedule(true)
        CloudTools.schedule(true)
        val manager = WorkManager.getInstance(context)
        val work = manager.getWorkInfosForUniqueWork("ppclash-webdav-backup").get()
        assertEquals(1, work.count { !it.state.isFinished })
        CloudTools.schedule(false)
        manager.cancelUniqueWork("ppclash-webdav-backup").result.get()
        assertTrue(manager.getWorkInfosForUniqueWork("ppclash-webdav-backup").get().all { it.state.isFinished })
    }
}
