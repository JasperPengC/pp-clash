package com.ppclash.app

import android.app.ActivityManager
import android.content.Intent
import android.system.Os
import android.system.OsConstants
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestName
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** Real WebView -> Tauri -> Rust -> native tests. Run only in the isolated .platformqa APK.
 * The complete-backup test needs a DAV server at -e davEndpoint <loopback directory URL>.
 * The VPN method requires its own invocation and normal system VPN consent.
 * Fixtures and mixed-proxy traffic stay on loopback; credentials/configuration are synthetic.
 */
@RunWith(AndroidJUnit4::class)
class PlatformParityInstrumentedTest {
    @get:Rule val testName = TestName()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val data by lazy { File(context.dataDir, "PPClash") }
    private val state by lazy { File(data, "state.json") }
    private var scenario: ActivityScenario<MainActivity>? = null
    private var bridge: WebViewInvokeBridge? = null
    private val savedFiles = linkedMapOf<File, ByteArray?>()
    private val savedBackupNames = linkedMapOf<File, Set<String>>()
    private val existingBackupDirectories = mutableSetOf<File>()
    private var originalSubStore: JSONObject? = null
    private var coldStoreFilesPreserved = false
    private var subStoreExisted = false
    private var remoteFile: URL? = null
    private var credentialValues: Map<String, String> = emptyMap()
    private var originalLedgers: Set<String> = emptySet()
    private val backgroundFixture by lazy { File(context.cacheDir, "platform-parity-background.json") }
    private var dataPreserved = false
    private var qaVpnAttempted = false
    private val vpnMixedPort = 17898
    private val vpnControllerPort = 17899
    private val vpnSecret = "qa-vpn-${UUID.randomUUID()}"

    @Before fun preserveQaDataAndSeedSafeState() {
        check(context.packageName.endsWith(".platformqa")) { "Only run against isolated QA data" }
        check(!File(data, ".ppclash-complete-restore.json").exists()) { "Resolve an existing QA restore before this test" }
        val savedDav = File(data, "webdav-settings.json")
        check(!savedDav.exists() || JSONObject(savedDav.readText()).getJSONObject("settings").getString("schedule") == "off") {
            "Disable the existing QA cloud schedule before business tests"
        }
        if (testName.methodName == "vpnLifecycleUsesRealKernelAndLoopbackMixedProxy") {
            val arguments = InstrumentationRegistry.getArguments()
            check(arguments.getString("class") ==
                "com.ppclash.app.PlatformParityInstrumentedTest#vpnLifecycleUsesRealKernelAndLoopbackMixedProxy") {
                "Select the VPN method alone in its own instrumentation invocation"
            }
            check(arguments.getString("waitForActivitiesToComplete") == "false") {
                "VPN instrumentation must use waitForActivitiesToComplete=false"
            }
            check(!ClashVpnService.status().getBoolean("running") && !qaVpnServiceExists()) {
                "Stop the existing QA VPN before this test; its configuration must remain untouched"
            }
            check(vpnPortsAvailable()) { "QA VPN test ports are already in use" }
            preserveVpnFiles()
        }
        data.mkdirs()
        for (name in listOf("state.json", "geo-update-status.json", "webdav-settings.json")) {
            val file = File(data, name)
            check(!file.exists() || file.isFile) { "Unexpected QA file: $name" }
            savedFiles[file] = file.takeIf { it.exists() }?.readBytes()
        }
        for (name in listOf("backups", "complete-backups")) {
            val directory = File(data, name)
            if (directory.exists()) existingBackupDirectories.add(directory)
            savedBackupNames[directory] = directory.list()?.toSet() ?: emptySet()
        }
        subStoreExisted = File(data, "sub-store").exists()
        originalLedgers = data.list()?.filter { it.startsWith("webdav-success-") && it.endsWith(".json") }?.toSet() ?: emptySet()
        credentialValues = context.getSharedPreferences("cloud-credentials", 0).all.mapValues { it.value as String }
        dataPreserved = true
        // A previous QA subscription must never cause VPN startup or online refresh in these tests.
        state.writeText(safeState().toString())
        File(data, "geo-update-status.json").delete()
    }

    @After fun restoreQaData() {
        if (!dataPreserved) return
        var cleanupFailure: Throwable? = null
        // Set before start_kernel so even a partially successful start is owned by this test.
        if (qaVpnAttempted) {
            try {
                assertFalse((invoke("stop_kernel") as JSONObject).getBoolean("running"))
                awaitQaVpnStopped()
            } catch (error: Throwable) {
                cleanupFailure = error
                try {
                    // Use the existing notification disconnect action if the WebView failed.
                    context.startService(Intent(context, ClashVpnService::class.java)
                        .setAction("com.ppclash.app.DISCONNECT_VPN"))
                    awaitQaVpnStopped()
                } catch (fallback: Throwable) { error.addSuppressed(fallback) }
            }
        }
        try {
            if ((originalSubStore != null || coldStoreFilesPreserved) && bridge == null) launch()
            originalSubStore?.let { snapshot -> invoke("sub_store_restore_snapshot", obj("snapshot" to snapshot)) }
            if (originalSubStore != null || coldStoreFilesPreserved) invoke("sub_store_stop")
        } catch (error: Throwable) {
            if (cleanupFailure == null) cleanupFailure = error else cleanupFailure.addSuppressed(error)
        }
        finally {
            try { bridge?.close() } catch (error: Throwable) { if (cleanupFailure == null) cleanupFailure = error }
            // Tauri owns the native event loop in this process; finishing its last Activity
            // also tears down the instrumentation target. Return it to the background instead.
            try { scenario?.onActivity { it.moveTaskToBack(true) } } catch (error: Throwable) { if (cleanupFailure == null) cleanupFailure = error }
            for ((file, bytes) in savedFiles) {
                if (bytes == null) file.delete() else file.writeBytes(bytes)
            }
            context.getSharedPreferences("cloud-credentials", 0).edit().clear().apply {
                for ((reference, ciphertext) in credentialValues) putString(reference, ciphertext)
            }.commit()
            data.listFiles()?.filter { it.name.startsWith("webdav-success-") && it.name.endsWith(".json") && it.name !in originalLedgers && it.isFile }?.forEach { it.delete() }
            // Only files created by this test inside the QA backup directories are removed.
            for ((directory, names) in savedBackupNames) {
                directory.listFiles()?.filter { it.name !in names && it.isFile }?.forEach { it.delete() }
                if (directory !in existingBackupDirectories && directory.list()?.isEmpty() == true) directory.delete()
            }
            if (!subStoreExisted && (originalSubStore != null || coldStoreFilesPreserved) && cleanupFailure == null) {
                File(data, "sub-store").deleteRecursively()
            }
            // Restore the prior policy as well as its bytes; an originally invalid policy may reject.
            if (bridge != null) runCatching { ResourceTools.scheduleSaved() }
            if (bridge != null) runCatching { CloudTools.schedule(false) }
            remoteFile?.let { url ->
                try {
                    val connection = url.openConnection() as HttpURLConnection
                    connection.connectTimeout = 5_000
                    connection.readTimeout = 5_000
                    connection.requestMethod = "DELETE"
                    try { check(connection.responseCode in listOf(200, 204, 404)) { "QA DAV cleanup failed" } }
                    finally { connection.disconnect() }
                } catch (error: Throwable) { if (cleanupFailure == null) cleanupFailure = error }
            }
        }
        cleanupFailure?.let { throw AssertionError("QA cleanup failed; original state was restored", it) }
    }

    @Test fun subStoreCrudScriptPreviewAndRestartUseRealNode() {
        launch()
        preserveSubStore()
        assertEquals("running", (invoke("sub_store_start") as JSONObject).getString("phase"))
        val name = "qa-source-${UUID.randomUUID()}"
        request("/api/subs", "POST", source(name))
        assertEquals(name, request("/api/sub/$name").getJSONObject("data").getString("name"))

        val script = "function operator(proxies) { return proxies.map(p => ({...p, name:'QA processed node'})); }"
        val processors = JSONArray().put(obj("type" to "Script Operator", "args" to obj("content" to script)))
        request("/api/sub/$name", "PATCH", obj("process" to processors))
        val exported = invoke("sub_store_request", obj("request" to serviceRequest("/download/$name?target=JSON"))) as String
        assertTrue("Real processor output was missing", exported.contains("QA processed node"))
        assertTrue(exported.contains("192.0.2.1"))

        val beforePreview = invoke("sub_store_snapshot") as JSONObject
        val previewEntry = source("qa-draft").put("process", JSONArray().put(obj(
            "type" to "Script Operator", "args" to obj("content" to
                "function operator(proxies) { \$substore.write('preview-only', '#qa-preview-key'); return proxies.map(p => ({...p,name:'QA draft node'})); }"))))
        val previewId = invoke("sub_store_preview_prepare") as String
        val preview = JSONObject(invoke("sub_store_preview", obj("id" to previewId,
            "request" to serviceRequest("/api/preview/sub", "POST", previewEntry))) as String)
        assertEquals("QA draft node", preview.getJSONObject("data").getJSONArray("processed").getJSONObject(0).getString("name"))
        assertEquals("Preview changed official storage", canonical(beforePreview), canonical(invoke("sub_store_snapshot")))

        request("/api/sub/$name", "PATCH", obj("process" to JSONArray().put(obj("type" to "Script Operator",
            "args" to obj("content" to "function operator() { throw new Error('QA processor rejected'); }")))))
        assertTrue(rejection("sub_store_request", obj("request" to serviceRequest("/download/$name?target=JSON"))).contains("QA processor rejected"))
        request("/api/sub/$name", "PATCH", obj("process" to processors))

        invoke("sub_store_stop")
        assertEquals("stopped", (invoke("sub_store_status") as JSONObject).getString("phase"))
        assertEquals("running", (invoke("sub_store_start") as JSONObject).getString("phase"))
        val persisted = request("/api/sub/$name").getJSONObject("data")
        assertEquals(name, persisted.getString("name"))
        assertEquals(canonical(processors), canonical(persisted.getJSONArray("process")))
        request("/api/sub/$name", "DELETE")
        val remaining = request("/api/subs").getJSONArray("data")
        assertFalse((0 until remaining.length()).any { remaining.getJSONObject(it).getString("name") == name })
    }

    @Test fun encryptedCompleteBackupRequiresPreviewDigestAndRestoresBothStores() {
        val configuredEndpoint = InstrumentationRegistry.getArguments().getString("davEndpoint")
            ?: "http://127.0.0.1:18765/platformqa/"
        val endpoint = URI(configuredEndpoint)
        check(endpoint.scheme == "http" && endpoint.host in listOf("127.0.0.1", "localhost", "::1")) { "DAV tests require a loopback test server" }
        val connection = obj("endpoint" to configuredEndpoint.trimEnd('/') + "/${UUID.randomUUID()}/", "username" to "", "password" to "")
        launch()
        preserveSubStore()
        val name = "qa-backed-up-${UUID.randomUUID()}"
        request("/api/subs", "POST", source(name))
        val original = safeState().put("profiles", JSONArray().put(obj("id" to "qa-profile", "name" to "QA original profile",
            "url" to "https://example.invalid/qa", "raw" to source(name).getString("content"))))
        original.getJSONObject("settings").put("overrides", JSONArray().put(obj("id" to "qa-override", "name" to "QA original override",
            "mode" to "yaml", "enabled" to true, "text" to "mode: rule")))
        val session = UUID.randomUUID().toString()
        invoke("load_app_state", obj("dataDir" to "PPClash", "session" to session))
        save(original, session)
        val uploadedStore = invoke("sub_store_snapshot") as JSONObject
        val passphrase = "QA-only passphrase ①"
        val backup = invoke("webdav_upload", obj("connection" to connection, "passphrase" to passphrase, "device" to "Android platform QA")) as String
        remoteFile = URL(connection.getString("endpoint") + backup)
        assertTrue((invoke("webdav_list", obj("connection" to connection)) as JSONArray).let { rows -> (0 until rows.length()).any { rows.getString(it) == backup } })
        val encrypted = readRemote(remoteFile!!)
        assertEquals("PPCLDAV1", String(encrypted.copyOfRange(0, 8), Charsets.US_ASCII))
        assertFalse("Cloud backup leaked plaintext", String(encrypted, Charsets.ISO_8859_1).contains("QA original profile"))
        rejection("webdav_preview", obj("connection" to connection, "name" to backup, "passphrase" to "wrong QA passphrase"))
        val preview = invoke("webdav_preview", obj("connection" to connection, "name" to backup, "passphrase" to passphrase)) as JSONObject
        assertEquals(1, preview.getInt("profiles"))
        assertTrue(preview.getInt("subStoreEntries") >= 1)
        assertEquals(64, preview.getString("digest").length)
        assertEquals("Decrypting a preview changed Sub-Store", canonical(uploadedStore), canonical(invoke("sub_store_snapshot")))
        assertEquals("Decrypting a preview changed application state", canonical(original),
            canonical(JSONObject(invoke("load_app_state", obj("dataDir" to "PPClash", "session" to session)) as String)))

        request("/api/sub/$name", "DELETE")
        request("/api/subs", "POST", source("qa-after-upload"))
        val changed = safeState().put("profiles", JSONArray())
        changed.getJSONObject("settings").put("mixedPort", 17171)
        save(changed, session)
        val changedStore = invoke("sub_store_snapshot") as JSONObject
        val changedState = invoke("load_app_state", obj("dataDir" to "PPClash", "session" to session)) as String
        val restoreArgs = obj("connection" to connection, "name" to backup, "passphrase" to passphrase, "session" to session, "digest" to "0".repeat(64))
        rejection("webdav_restore", restoreArgs)
        assertEquals(changedState, invoke("load_app_state", obj("dataDir" to "PPClash", "session" to session)))
        assertEquals(canonical(changedStore), canonical(invoke("sub_store_snapshot")))
        invoke("webdav_restore", restoreArgs.put("digest", preview.getString("digest")))
        val freshSession = UUID.randomUUID().toString()
        val restored = JSONObject(invoke("load_app_state", obj("dataDir" to "PPClash", "session" to freshSession)) as String)
        assertEquals("QA original profile", restored.getJSONArray("profiles").getJSONObject(0).getString("name"))
        assertEquals("QA original override", restored.getJSONObject("settings").getJSONArray("overrides").getJSONObject(0).getString("name"))
        assertEquals("Device-local settings should survive portable restore", 17171, restored.getJSONObject("settings").getInt("mixedPort"))
        assertEquals("Complete restore omitted Sub-Store", canonical(uploadedStore), canonical(invoke("sub_store_snapshot")))
        rejection("save_app_state", obj("content" to changed.toString(), "dataDir" to "PPClash", "session" to session))
    }

    @Test fun legacyInvalidGeoIntervalStillStartsUiAndCommitsState() {
        val legacy = safeState()
        legacy.getJSONObject("settings").put("geoUpdateInterval", 1.5)
        state.writeText(legacy.toString())
        launch()
        assertEquals(true, bridge!!.evaluate("Boolean(document.querySelector('.android-shell'))"))
        val session = UUID.randomUUID().toString()
        invoke("load_app_state", obj("dataDir" to "PPClash", "session" to session))
        legacy.put("qaCommittedMarker", "committed despite invalid Geo interval")
        save(legacy, session)
        val persisted = JSONObject(invoke("load_app_state", obj("dataDir" to "PPClash", "session" to session)) as String)
        assertEquals("committed despite invalid Geo interval", persisted.getString("qaCommittedMarker"))
        assertEquals(1.5, JSONObject(state.readText()).getJSONObject("settings").getDouble("geoUpdateInterval"), 0.0)
        try {
            val status = invoke("geo_auto_update_status") as JSONObject
            assertFalse("Invalid Geo policy was silently accepted", status.optString("error").isBlank())
        } catch (_: InvokeRejected) { /* Existing error API is also a visible configuration failure. */ }
    }

    @Test fun systemNavigationBarDoesNotCoverAppNavigation() {
        launch()
        val bottom = bridge!!.screenY((bridge!!.evaluate("document.querySelector('.android-nav').getBoundingClientRect().bottom") as Number).toDouble())
        var availableBottom = 0.0
        scenario!!.onActivity { activity ->
            val view = activity.window.decorView
            val insets = androidx.core.view.ViewCompat.getRootWindowInsets(view)!!
            val systemBottom = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()).bottom
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            availableBottom = (location[1] + view.height - systemBottom).toDouble()
        }
        assertTrue("App navigation overlaps the system navigation bar: app=$bottom safe=$availableBottom", bottom <= availableBottom + 1)
    }

    @Test fun overviewCardsKeepTheirContentsInsideTheirBounds() {
        launch()
        val geometry = JSONObject(bridge!!.evaluate("JSON.stringify((() => {const card=document.querySelector('.android-connection-card'); const node=document.querySelector('.android-node-block'); const zone=document.querySelector('.android-switch-zone'); return {card:card.getBoundingClientRect().bottom,node:node.getBoundingClientRect().bottom,zone:zone.getBoundingClientRect().bottom,label:zone.querySelector(':scope > span').getBoundingClientRect().bottom,minHeight:getComputedStyle(card).minHeight,height:getComputedStyle(card).height,rows:getComputedStyle(card).gridTemplateRows,parentRows:getComputedStyle(card.parentElement).gridTemplateRows,supports:CSS.supports('min-height','min-content')};})())") as String)
        assertTrue("Connection card shrank below its node controls: $geometry", geometry.getDouble("node") <= geometry.getDouble("card") + 1)
        assertTrue("Power label extends beyond its scrollable zone: $geometry", geometry.getDouble("label") <= geometry.getDouble("zone") + 1)
        val reachability = JSONObject(bridge!!.evaluate("JSON.stringify((() => {const scroll=document.querySelector('.android-overview');const label=document.querySelector('.android-switch-zone > span');const previous=scroll.scrollTop;scroll.scrollTop=scroll.scrollHeight;const viewport=scroll.getBoundingClientRect();const bounds=label.getBoundingClientRect();const result={top:viewport.top,bottom:viewport.bottom,labelTop:bounds.top,labelBottom:bounds.bottom};scroll.scrollTop=previous;return result;})())") as String)
        assertTrue("Power label cannot be reached by scrolling: $reachability", reachability.getDouble("labelTop") >= reachability.getDouble("top") - 1 && reachability.getDouble("labelBottom") <= reachability.getDouble("bottom") + 1)
    }

    @Test fun keyboardAndDialogShareTheSameScreenBoundary() {
        launch()
        bridge!!.evaluate("(() => { const modal=document.createElement('div'); modal.id='platformqa-ime-modal'; modal.className='modal-backdrop'; modal.innerHTML='<div class=\"modal-card\"><input id=\"platformqa-ime-input\" type=\"text\" /></div>'; document.body.append(modal); modal.querySelector('input').focus(); return true; })()")
        try {
            bridge!!.keyboard(true)
            var keyboardTop = 0.0
            var bottom = 0.0
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (System.nanoTime() < deadline) {
                scenario!!.onActivity { activity ->
                    val view = activity.window.decorView
                    val insets = androidx.core.view.ViewCompat.getRootWindowInsets(view)!!
                    if (insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime())) {
                        val location = IntArray(2)
                        view.getLocationOnScreen(location)
                        keyboardTop = (location[1] + view.height - insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom).toDouble()
                    }
                }
                val height = bridge!!.evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--android-ime-height')) || 0") as Number
                bottom = bridge!!.screenY((bridge!!.evaluate("document.getElementById('platformqa-ime-modal').getBoundingClientRect().bottom") as Number).toDouble())
                if (keyboardTop > 0 && height.toDouble() > 0 && kotlin.math.abs(bottom - keyboardTop) <= 2) break
                Thread.sleep(100)
            }
            assertTrue("The real software keyboard never opened", keyboardTop > 0)
            assertEquals("Dialog and keyboard use different screen coordinates", keyboardTop, bottom, 2.0)
        } finally {
            bridge!!.keyboard(false)
            bridge!!.evaluate("document.getElementById('platformqa-ime-modal')?.remove()")
        }
    }

    @Test fun downloadedGeodataSurvivesRestartAndRejectsInvalidReplacement() {
        val arguments = InstrumentationRegistry.getArguments()
        val bundledSha256 = arguments.getString("bundledGeositeSha256")?.trim()?.lowercase()
            ?: error("Pass bundledGeositeSha256 from the current Go geodata.zip manifest")
        check(bundledSha256.matches(Regex("[0-9a-f]{64}"))) { "Invalid bundledGeositeSha256" }
        val endpoint = arguments.getString("geoEndpoint")
            ?: "http://127.0.0.1:18765/geo-fixture/"
        requireLoopback(endpoint)
        preserveVpnFiles()
        val valid = URL(endpoint + "geosite.dat")
        val expected = readRemote(valid)
        launch()
        val size = invoke("download_geo_resource", obj("name" to "geosite.dat", "url" to valid.toString(),
            "proxyUrl" to "", "mirrorPrefix" to "")) as Number
        assertEquals(expected.size.toLong(), size.toLong())
        assertArrayEquals(expected, File(data, "geosite.dat").readBytes())
        val source = File(data, ".geodata-source-geosite.dat.json")
        val sourceBefore = source.readBytes()
        assertEquals(valid.toString(), JSONObject(String(sourceBefore)).getString("url"))
        val reason = rejection("download_geo_resource", obj("name" to "geosite.dat",
            "url" to endpoint + "invalid-geosite.dat", "proxyUrl" to "", "mirrorPrefix" to ""))
        assertTrue("Invalid update should report its reason", reason.isNotBlank())
        assertArrayEquals("Invalid replacement changed valid data", expected, File(data, "geosite.dat").readBytes())
        assertArrayEquals("Invalid replacement changed provenance", sourceBefore, source.readBytes())
        bridge!!.close()
        bridge = null
        scenario!!.recreate()
        scenario!!.onActivity { it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        bridge = WebViewInvokeBridge(scenario!!)
        bridge!!.awaitReady()
        assertArrayEquals("Activity recreation discarded a verified downloaded update", expected, File(data, "geosite.dat").readBytes())
        assertArrayEquals("Activity recreation changed provenance", sourceBefore, source.readBytes())
        // Validation runs Go ensureGeodata, which preserves verified user updates.
        val config = File(data, "config.yaml")
        config.writeText(obj("mixed-port" to 0, "port" to 0, "socks-port" to 0,
            "external-controller" to "127.0.0.1:$vpnControllerPort", "secret" to vpnSecret,
            "mode" to "direct", "allow-lan" to false, "bind-address" to "127.0.0.1",
            "geo-auto-update" to false, "find-process-mode" to "off",
            "dns" to obj("enable" to false), "tun" to obj("enable" to false),
            "proxies" to JSONArray(), "proxy-groups" to JSONArray(),
            "rules" to JSONArray().put("MATCH,DIRECT")).toString())
        invoke("validate_config", obj("configPath" to config.absolutePath))
        assertArrayEquals("Go ensureGeodata discarded a verified downloaded update", expected, File(data, "geosite.dat").readBytes())
        assertArrayEquals("Go ensureGeodata changed provenance", sourceBefore, source.readBytes())
        // Explicit reinstall intentionally returns to offline data and removes online provenance.
        invoke("reinstall_bundled_resources")
        val bundled = File(data, "geosite.dat").readBytes()
        val actualSha256 = MessageDigest.getInstance("SHA-256").digest(bundled)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        assertEquals("Explicit reinstall did not restore the current bundled geosite", bundledSha256, actualSha256)
        assertFalse("Explicit reinstall retained online provenance", source.exists())
        val files = invoke("list_resource_files") as JSONArray
        val geosite = (0 until files.length()).map { files.getJSONObject(it) }.single { it.getString("name") == "geosite.dat" }
        assertTrue(geosite.getBoolean("exists"))
        assertEquals(bundled.size.toLong(), geosite.getLong("size"))
    }

    @Test fun vpnLifecycleUsesRealKernelAndLoopbackMixedProxy() {
        val endpoint = InstrumentationRegistry.getArguments().getString("vpnFixtureUrl")
            ?: "http://127.0.0.1:18765/geo-fixture/geosite.dat"
        requireLoopback(endpoint)
        val fixture = URL(endpoint)
        val expected = readVpnFixture(fixture, Proxy.NO_PROXY)
        assertTrue("Loopback fixture must contain bytes", expected.isNotEmpty())
        launch()
        val activity = currentActivity()
        assertFalse("QA VPN was already running", vpnStatus().getBoolean("running"))
        val config = File(data, "config.yaml")
        config.writeText("""
            mixed-port: $vpnMixedPort
            port: 0
            socks-port: 0
            redir-port: 0
            tproxy-port: 0
            external-controller: 127.0.0.1:$vpnControllerPort
            secret: $vpnSecret
            mode: direct
            allow-lan: false
            bind-address: 127.0.0.1
            geo-auto-update: false
            find-process-mode: off
            dns:
              enable: false
            tun:
              enable: false
            profile:
              store-selected: false
              store-fake-ip: false
            proxies: []
            proxy-groups: []
            rules:
              - MATCH,DIRECT
        """.trimIndent() + "\n")
        val mixedProxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", vpnMixedPort))
        repeat(2) { index ->
            val round = index + 1
            assertSame("VPN round $round replaced MainActivity", activity, currentActivity())
            invoke("validate_config", obj("configPath" to config.absolutePath))
            qaVpnAttempted = true
            val started = invoke("start_kernel", obj("configPath" to config.absolutePath,
                "controllerPort" to vpnControllerPort, "controllerSecret" to vpnSecret)) as JSONObject
            assertTrue("VPN round $round did not start", started.getBoolean("running"))
            assertEquals(android.os.Process.myPid(), started.getInt("pid"))
            assertTrue(vpnStatus().getBoolean("running"))
            assertEquals("Controller version differs from the packaged core", "v1.19.34", controllerRequest("/version").getString("version"))
            assertTrue("Controller omitted DIRECT", controllerRequest("/proxies").getJSONObject("proxies").has("DIRECT"))
            val direct = controllerRequest("/proxies/DIRECT")
            assertEquals("DIRECT", direct.getString("name"))
            assertEquals("Direct", direct.getString("type"))
            assertArrayEquals("VPN round $round mixed proxy changed fixture bytes", expected,
                readVpnFixture(fixture, mixedProxy))
            // Subscription updates use the real controller reload API on Android too.
            config.writeText(config.readText().replace("mode: direct", "mode: rule"))
            invoke("mihomo_request", obj("method" to "PUT", "path" to "/configs?force=true",
                "body" to obj("path" to config.absolutePath).toString(),
                "secret" to vpnSecret, "base" to "http://127.0.0.1:$vpnControllerPort"))
            assertEquals("VPN round $round did not reload the saved configuration", "rule",
                controllerRequest("/configs").getString("mode"))
            invoke("mihomo_request", obj("method" to "PATCH", "path" to "/configs",
                "body" to obj("mode" to "direct").toString(),
                "secret" to vpnSecret, "base" to "http://127.0.0.1:$vpnControllerPort"))
            assertEquals("VPN round $round did not apply the controller patch", "direct",
                controllerRequest("/configs").getString("mode"))
            assertArrayEquals("VPN round $round reload changed fixture bytes", expected,
                readVpnFixture(fixture, mixedProxy))
            val stopped = invoke("stop_kernel") as JSONObject
            assertFalse("VPN round $round did not stop", stopped.getBoolean("running"))
            assertTrue("Stopped VPN retained a pid", stopped.isNull("pid"))
            awaitQaVpnStopped()
            val idle = vpnStatus()
            assertFalse("Stopped VPN still reports running", idle.getBoolean("running"))
            assertTrue("Stopped VPN retained a pid", idle.isNull("pid"))
            assertEquals("Stopped VPN reclaimed unrelated processes", 0, idle.getJSONArray("reclaimed").length())
            assertSame("VPN round $round replaced MainActivity", activity, currentActivity())
            android.util.Log.i("PPClashPlatformQA", "VPN round $round passed: controller, mixed fixture, service/ports released")
        }
    }

    /** Phase one: this must run in its own instrumentation invocation before the cold phase. */
    @Test fun prepareSavedWebDavFixtureForColdBackgroundBackup() {
        check(!backgroundFixture.exists()) { "Consume or remove the previous QA background fixture first" }
        val endpoint = InstrumentationRegistry.getArguments().getString("davEndpoint") ?: "http://127.0.0.1:18765/platformqa/"
        requireLoopback(endpoint)
        launch()
        preserveSubStore()
        val sourceName = "qa-cold-${UUID.randomUUID()}"
        request("/api/subs", "POST", source(sourceName))
        val settings = obj("endpoint" to endpoint, "directory" to UUID.randomUUID().toString(), "username" to "qa",
            "deviceName" to "Android cold QA", "schedule" to "off", "retention" to 3)
        val saved = invoke("save_webdav_settings", obj("request" to obj("settings" to settings,
            "password" to obj("intent" to "replace", "value" to "QA DAV password"),
            "backupPassphrase" to obj("intent" to "replace", "value" to "QA cold passphrase ①")))) as JSONObject
        assertTrue(saved.getBoolean("configured"))
        assertTrue(saved.getBoolean("hasPassword"))
        assertTrue(saved.getBoolean("hasBackupPassphrase"))
        assertEquals("off", saved.getJSONObject("settings").getString("schedule"))
        val stored = JSONObject(File(data, "webdav-settings.json").readText())
        assertFalse(stored.isNull("passwordRef"))
        assertFalse(stored.isNull("backupPassphraseRef"))
        // Only the cached fixture is enabled. The live WebView policy remains off until cleanup.
        stored.getJSONObject("settings").put("schedule", "daily")
        val seeded = safeState().put("profiles", JSONArray().put(obj("id" to "qa-cold-profile", "name" to "QA background profile",
            "url" to "https://example.invalid/qa-cold", "raw" to source(sourceName).getString("content"))))
        backgroundFixture.writeText(obj("fixtureVersion" to 1, "state" to seeded, "storedSettings" to stored,
            "sourceName" to sourceName, "subStoreSnapshot" to invoke("sub_store_snapshot")).toString())
        assertTrue("Off policy unexpectedly uploaded a background backup", data.listFiles()?.none {
            it.name.startsWith("webdav-success-") && it.name !in originalLedgers
        } != false)
    }

    /** Phase two: invoke alone in a new process; no MainActivity exists until after upload proof. */
    @Test fun savedWebDavColdNativeBackupUploadsCompleteEncryptedContents() {
        check(InstrumentationRegistry.getArguments().getString("class") ==
            "com.ppclash.app.PlatformParityInstrumentedTest#savedWebDavColdNativeBackupUploadsCompleteEncryptedContents") {
            "Select this method alone in a new instrumentation invocation"
        }
        check(backgroundFixture.exists()) { "Run prepareSavedWebDavFixtureForColdBackgroundBackup first" }
        val fixture = JSONObject(backgroundFixture.readText())
        assertEquals(1, fixture.getInt("fixtureVersion"))
        val stored = fixture.getJSONObject("storedSettings")
        val policy = stored.getJSONObject("settings")
        requireLoopback(policy.getString("endpoint"))
        var hasActivity = false
        instrumentation.runOnMainSync {
            hasActivity = Stage.values().filter { it != Stage.DESTROYED }.any {
                ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it).isNotEmpty()
            }
        }
        check(!hasActivity) { "Cold backup must run in a fresh process with no Activity" }
        val fixtureSnapshot = fixture.getJSONObject("subStoreSnapshot")
        val storeDirectory = File(data, "sub-store").apply { mkdirs() }
        // Preserve absent files as absent; empty objects are not valid Sub-Store snapshots.
        coldStoreFilesPreserved = true
        for (name in listOf("root.json", "sub-store.json")) {
            val file = File(storeDirectory, name)
            val previous = file.takeIf { it.exists() }?.readBytes()
            savedFiles[file] = previous
            file.writeText(fixtureSnapshot.getJSONObject("files").getJSONObject(name).toString())
        }
        state.writeText(fixture.getJSONObject("state").toString())
        File(data, "webdav-settings.json").writeText(stored.toString())
        System.loadLibrary("ppclash_lib")
        CloudTools.initialize(context, context.dataDir.absolutePath)
        CloudTools.credential("write", stored.getString("passwordRef"), "QA DAV password")
        CloudTools.credential("write", stored.getString("backupPassphraseRef"), "QA cold passphrase ①")
        val executor = InstrumentationRegistry.getArguments().getString("backupExecutor") ?: "native"
        check(executor in setOf("native", "workmanager")) { "Unknown cold backup executor" }
        if (executor == "workmanager") {
            val manager = androidx.work.WorkManager.getInstance(context)
            val request = androidx.work.OneTimeWorkRequestBuilder<CloudBackupWorker>()
                .setConstraints(androidx.work.Constraints.Builder()
                    .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED).build()).build()
            val job = "platformqa-cold-complete-backup"
            try {
                manager.enqueueUniqueWork(job, androidx.work.ExistingWorkPolicy.REPLACE, request).result.get(10, TimeUnit.SECONDS)
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
                var status = manager.getWorkInfoById(request.id).get(5, TimeUnit.SECONDS)!!
                while (!status.state.isFinished && System.nanoTime() < deadline) {
                    Thread.sleep(100)
                    status = manager.getWorkInfoById(request.id).get(5, TimeUnit.SECONDS)!!
                }
                assertEquals("Cold WorkManager backup did not succeed", androidx.work.WorkInfo.State.SUCCEEDED, status.state)
                android.util.Log.i("PPClashPlatformQA", "Cold WorkManager completed a real CloudBackupWorker before Activity startup")
            } finally { manager.cancelUniqueWork(job).result.get(10, TimeUnit.SECONDS) }
        } else {
            assertEquals("Cold JNI backup rejected the saved policy", 0, CloudTools.runBackupNative())
        }
        instrumentation.runOnMainSync {
            hasActivity = Stage.values().filter { it != Stage.DESTROYED }.any {
                ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it).isNotEmpty()
            }
        }
        assertFalse("A cold backup created an Activity before upload verification", hasActivity)
        val newLedgers = data.listFiles()!!.filter { it.name.startsWith("webdav-success-") && it.name.endsWith(".json") && it.name !in originalLedgers }
        assertEquals("No new backup completed before Activity startup", 1, newLedgers.size)
        val ledger = JSONObject(newLedgers.single().readText())
        assertTrue(ledger.getLong("lastSuccessAt") > 0)
        val names = ledger.getJSONArray("confirmed")
        assertEquals(1, names.length())
        remoteFile = URL(policy.getString("endpoint").trimEnd('/') + "/" + policy.getString("directory") + "/" + names.getString(0))
        val encrypted = readRemote(remoteFile!!)
        assertEquals("PPCLDAV1", String(encrypted.copyOfRange(0, 8), Charsets.US_ASCII))
        val plain = decryptBackup(encrypted, "QA cold passphrase ①")
        assertEquals(2, plain.getInt("version"))
        assertEquals("QA background profile", plain.getJSONObject("state").getJSONArray("profiles").getJSONObject(0).getString("name"))
        assertEquals("No-Activity export omitted full Sub-Store data", canonical(fixtureSnapshot), canonical(plain.getJSONObject("subStoreSnapshot")))
        android.util.Log.i("PPClashPlatformQA", "Cold $executor encrypted upload and complete contents verified before Activity startup")
        // Only after proving the cold upload do we launch the existing UI for service shutdown/cleanup.
        launch()
        assertEquals(1, (invoke("webdav_backup_history", obj("offset" to 0, "limit" to 10)) as JSONObject).getInt("total"))
        backgroundFixture.delete()
    }

    private fun launch() {
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        scenario = ActivityScenario.launch(intent)
        scenario!!.onActivity { it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        bridge = WebViewInvokeBridge(scenario!!)
        bridge!!.awaitReady()
        // Hydration writes a controller secret once. Wait for that write before native test sessions.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        var stamp = state.lastModified()
        var stableSince = System.nanoTime()
        while (System.nanoTime() < deadline) {
            Thread.sleep(100)
            val next = state.lastModified()
            if (stamp != next) { stamp = next; stableSince = System.nanoTime() }
            if (System.nanoTime() - stableSince > TimeUnit.SECONDS.toNanos(1)) return
        }
        throw AssertionError("QA frontend hydration did not settle")
    }

    private fun preserveSubStore() { originalSubStore = invoke("sub_store_snapshot") as JSONObject }
    private fun preserveVpnFiles() {
        val resourceNames = setOf("geoip.metadb", "geoip.dat", "geosite.dat", "asn.mmdb", "country.mmdb", "geoip.db")
        val names = linkedSetOf("config.yaml", "geoip.metadb", "geoip.dat", "geosite.dat", "ASN.mmdb", "country.mmdb", "geoip.db")
        for (name in listOf("geoip.metadb", "geoip.dat", "geosite.dat", "ASN.mmdb")) {
            names.add(".geodata-source-$name.json")
        }
        data.list()?.filter { it.lowercase() in resourceNames ||
            (it.startsWith(".geodata-source-") && it.endsWith(".json")) }?.let { names.addAll(it) }
        for (name in names) {
            val file = File(data, name)
            val stat = runCatching { Os.lstat(file.absolutePath) }.getOrNull()
            check(stat == null || !OsConstants.S_ISLNK(stat.st_mode)) { "QA VPN test cannot restore a symlink: $name" }
            check(!file.exists() || file.isFile) { "Unexpected QA VPN file: $name" }
            savedFiles[file] = file.takeIf { it.exists() }?.readBytes()
        }
    }
    private fun currentActivity(): MainActivity {
        var activity: MainActivity? = null
        scenario!!.onActivity { activity = it }
        return checkNotNull(activity)
    }
    private fun vpnStatus() = invoke("kernel_status", obj("secret" to vpnSecret, "port" to vpnControllerPort)) as JSONObject
    private fun controllerRequest(path: String) = JSONObject(invoke("mihomo_request", obj(
        "base" to "http://127.0.0.1:$vpnControllerPort", "secret" to vpnSecret,
        "method" to "GET", "path" to path, "body" to null)) as String)
    @Suppress("DEPRECATION")
    private fun qaRunningServices(): List<ActivityManager.RunningServiceInfo> =
        (context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as ActivityManager)
            .getRunningServices(32)
    private fun qaVpnServiceExists(services: List<ActivityManager.RunningServiceInfo> = qaRunningServices()): Boolean =
        services.any {
            it.service.packageName == context.packageName && it.service.className == ClashVpnService::class.java.name
        }
    private fun vpnPortsAvailable(): Boolean = runCatching {
        ServerSocket().use { mixed ->
            ServerSocket().use { controller ->
                mixed.reuseAddress = true
                controller.reuseAddress = true
                mixed.bind(InetSocketAddress("127.0.0.1", vpnMixedPort))
                controller.bind(InetSocketAddress("127.0.0.1", vpnControllerPort))
            }
        }
        true
    }.getOrDefault(false)
    private fun vpnPortRebindDiagnostic(port: Int): String = runCatching {
        ServerSocket().use { socket ->
            socket.reuseAddress = true
            socket.bind(InetSocketAddress("127.0.0.1", port))
        }
        "127.0.0.1:$port rebind=ok SO_REUSEADDR=true"
    }.getOrElse { error ->
        "127.0.0.1:$port rebind=failed SO_REUSEADDR=true ${error.javaClass.name}: ${error.message}"
    }
    private fun awaitQaVpnStopped() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        var lastDiagnostic = "No stop sample was collected"
        do {
            val status = ClashVpnService.status()
            val services = qaRunningServices()
            val serviceExists = qaVpnServiceExists(services)
            val portsAvailable = vpnPortsAvailable()
            if (!status.getBoolean("running") && !serviceExists && portsAvailable) return
            val reportedServices = services.joinToString(prefix = "[", postfix = "]") {
                "${it.service.flattenToShortString()} pid=${it.pid} foreground=${it.foreground}"
            }
            lastDiagnostic = "status=$status qaVpnServiceExists=$serviceExists getRunningServices=$reportedServices " +
                "combinedPortsAvailable=$portsAvailable; ${vpnPortRebindDiagnostic(vpnMixedPort)}; " +
                vpnPortRebindDiagnostic(vpnControllerPort)
            Thread.sleep(100)
        } while (System.nanoTime() < deadline)
        throw AssertionError("QA VPN did not release its service and mixed/controller ports within 15 seconds: $lastDiagnostic")
    }
    private fun readVpnFixture(url: URL, proxy: Proxy): ByteArray {
        requireLoopback(url.toString())
        val connection = url.openConnection(proxy) as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 10_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("Connection", "close")
        return try {
            assertEquals("Loopback fixture request failed", 200, connection.responseCode)
            assertEquals("Fixture did not use the requested proxy", proxy != Proxy.NO_PROXY, connection.usingProxy())
            connection.inputStream.use { it.readBytes() }
        } finally { connection.disconnect() }
    }
    private fun invoke(command: String, args: JSONObject = JSONObject()): Any? {
        android.util.Log.i("PPClashPlatformQA", "Invoking $command")
        return bridge!!.invoke(command, args).also { android.util.Log.i("PPClashPlatformQA", "Completed $command") }
    }
    private fun rejection(command: String, args: JSONObject): String {
        try { invoke(command, args) } catch (error: InvokeRejected) { return error.message ?: "" }
        throw AssertionError("$command unexpectedly succeeded")
    }
    private fun save(document: JSONObject, session: String) {
        invoke("save_app_state", obj("content" to document.toString(), "dataDir" to "PPClash", "session" to session))
    }
    private fun request(path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        JSONObject(invoke("sub_store_request", obj("request" to serviceRequest(path, method, body))) as String).also {
            assertEquals("Sub-Store rejected $method $path", "success", it.getString("status"))
        }
    private fun serviceRequest(path: String, method: String = "GET", body: JSONObject? = null) =
        obj("path" to path, "method" to method, "body" to body)
    private fun source(name: String) = obj("name" to name, "source" to "local", "process" to JSONArray(), "content" to
        "proxies:\n  - name: Sample\n    type: ss\n    server: 192.0.2.1\n    port: 443\n    cipher: aes-128-gcm\n    password: synthetic\n")
    private fun safeState() = obj("profiles" to JSONArray(), "activeId" to null, "settings" to obj(
        "geoAutoUpdate" to false, "geoUpdateInterval" to 24, "geoUrls" to JSONObject(), "updateCheckOnLaunch" to false,
        "mixedPort" to 17890, "controllerPort" to 17891), "tunEnabled" to false, "sysProxyEnabled" to false)
    private fun readRemote(url: URL): ByteArray {
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 30_000
        return try { check(connection.responseCode == 200); connection.inputStream.use { it.readBytes() } }
            finally { connection.disconnect() }
    }
    private fun requireLoopback(endpoint: String) {
        val uri = URI(endpoint)
        check(uri.scheme == "http" && uri.host in listOf("127.0.0.1", "localhost", "::1")) { "DAV tests require a loopback test server" }
    }
    private fun decryptBackup(bytes: ByteArray, passphrase: String): JSONObject {
        val password = PBEKeySpec(passphrase.toCharArray(), bytes.copyOfRange(8, 24), 600_000, 256)
        val key = try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(password).encoded }
            finally { password.clearPassword() }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, bytes.copyOfRange(24, 36)))
            cipher.updateAAD(bytes.copyOfRange(0, 36))
            JSONObject(String(cipher.doFinal(bytes, 36, bytes.size - 36), Charsets.UTF_8))
        } finally { key.fill(0) }
    }
}

private fun obj(vararg entries: Pair<String, Any?>) = JSONObject().apply {
    for ((key, value) in entries) put(key, value ?: JSONObject.NULL)
}

private fun canonical(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}") { key -> JSONObject.quote(key) + ":" + canonical(value.get(key)) }
    is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
    is String -> JSONObject.quote(value)
    else -> value.toString()
}

private class InvokeRejected(message: String) : RuntimeException(message)

/** Promise callbacks live only in androidTest and call the existing public Tauri bridge. */
private class WebViewInvokeBridge(private val scenario: ActivityScenario<MainActivity>) {
    private class Pending(val latch: CountDownLatch = CountDownLatch(1)) { @Volatile var result: String? = null }
    private val pending = ConcurrentHashMap<String, Pending>()
    private var webView: WebView? = null
    private val callback = object {
        @JavascriptInterface fun complete(id: String, result: String) {
            pending[id]?.let { it.result = result; it.latch.countDown() }
        }
    }

    fun awaitReady() {
        val started = System.nanoTime()
        fun diagnostic(phase: String): JSONObject {
            val values = evaluate("JSON.stringify({callback:typeof window.PlatformQaCallback,internals:typeof window.__TAURI_INTERNALS__,invoke:typeof window.__TAURI_INTERNALS__?.invoke,shell:!!document.querySelector('.android-shell'),readyState:document.readyState,root:!!document.getElementById('root'),alert:!!document.querySelector('[role=alert]'),hidden:document.hidden})") as? String
            val state = JSONObject(values ?: "{}")
            state.put("phase", phase).put("elapsedMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started))
            scenario.onActivity { state.put("urlScheme", URI(webView!!.url ?: "").scheme ?: "none") }
            android.util.Log.i("PPClashPlatformQA", "WebView readiness: $state")
            return state
        }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (webView == null && System.nanoTime() < deadline) {
            scenario.onActivity { activity -> webView = findWebView(activity.window.decorView) }
            if (webView == null) Thread.sleep(100)
        }
        check(webView != null) { "MainActivity never created its WebView" }
        diagnostic("before-callback-reload")
        scenario.onActivity {
            webView!!.addJavascriptInterface(callback, "PlatformQaCallback")
            webView!!.reload() // WebView exposes a new JavascriptInterface on the next document.
        }
        var nextDiagnostic = System.nanoTime()
        while (System.nanoTime() < deadline) {
            if (evaluate("Boolean(window.PlatformQaCallback && window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function' && document.querySelector('.android-shell'))") == true) {
                diagnostic("ready")
                return
            }
            if (System.nanoTime() >= nextDiagnostic) {
                diagnostic("waiting-after-reload")
                nextDiagnostic = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            }
            Thread.sleep(100)
        }
        throw AssertionError("The production Tauri WebView bridge or Android UI never became ready: ${diagnostic("timeout")}")
    }

    fun evaluate(expression: String): Any? {
        val waiting = Pending()
        scenario.onActivity { webView!!.evaluateJavascript(expression) { result -> waiting.result = result; waiting.latch.countDown() } }
        check(waiting.latch.await(5, TimeUnit.SECONDS)) { "WebView evaluation timed out" }
        val value = JSONTokener(waiting.result ?: "null").nextValue()
        return if (value == JSONObject.NULL) null else value
    }

    fun screenY(cssY: Double): Double {
        var result = 0.0
        scenario.onActivity {
            val location = IntArray(2)
            webView!!.getLocationOnScreen(location)
            result = location[1] + cssY * webView!!.resources.displayMetrics.density
        }
        return result
    }

    fun keyboard(show: Boolean) {
        scenario.onActivity { activity ->
            val manager = activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
            if (show) {
                webView!!.requestFocus()
                manager.showSoftInput(webView, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
            } else manager.hideSoftInputFromWindow(webView!!.windowToken, 0)
        }
    }

    fun invoke(command: String, args: JSONObject): Any? {
        val id = UUID.randomUUID().toString()
        val waiting = Pending()
        pending[id] = waiting
        val script = """
            (async () => {
              try {
                const value = await window.__TAURI_INTERNALS__.invoke(${JSONObject.quote(command)}, $args);
                PlatformQaCallback.complete(${JSONObject.quote(id)}, JSON.stringify({ok:true,value:value ?? null}));
              } catch(error) {
                PlatformQaCallback.complete(${JSONObject.quote(id)}, JSON.stringify({ok:false,error:typeof error==='string'?error:JSON.stringify(error)}));
              }
            })();
        """.trimIndent()
        try {
            scenario.onActivity { webView!!.evaluateJavascript(script, null) }
            check(waiting.latch.await(90, TimeUnit.SECONDS)) { "Tauri command timed out: $command" }
            val result = JSONObject(waiting.result ?: error("No WebView promise result"))
            if (!result.getBoolean("ok")) throw InvokeRejected(result.optString("error", "Tauri command rejected"))
            return result.opt("value").let { if (it == JSONObject.NULL) null else it }
        } finally { pending.remove(id) }
    }

    fun close() {
        scenario.onActivity { webView?.removeJavascriptInterface("PlatformQaCallback") }
        pending.clear()
    }
    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) findWebView(view.getChildAt(index))?.let { return it }
        return null
    }
}
