package com.jfamily.mywhere

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Geocoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.jfamily.mywhere.bridge.WebBridge
import com.jfamily.mywhere.data.Prefs
import com.jfamily.mywhere.location.LocationRepository
import com.jfamily.mywhere.location.ShareService
import com.jfamily.mywhere.net.RelayClient
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var prefs: Prefs
    private lateinit var locationRepo: LocationRepository

    private var pendingSharedText: String = ""
    @Volatile private var canBack: Boolean = false

    // ── 권한 런처 (멤버 프로퍼티 — STARTED 이전 등록) ──
    private val locationPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            pushPermissions()
        }
    private val singlePermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            pushPermissions()
        }

    // ── 내보내기/가져오기 런처 ──
    private var pendingExportJson: String = ""
    private val exportLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
            if (uri != null && pendingExportJson.isNotEmpty()) {
                try {
                    contentResolver.openOutputStream(uri)?.use { it.write(pendingExportJson.toByteArray()) }
                    uiToast("설정을 내보냈습니다")
                } catch (e: Exception) {
                    uiToast("내보내기 실패: ${e.message}")
                }
            }
        }
    private val importLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) {
                try {
                    val text = contentResolver.openInputStream(uri)
                        ?.bufferedReader()?.use { it.readText() } ?: ""
                    if (prefs.importJson(text)) {
                        uiToast("설정을 가져왔습니다")
                        evalJs("window.__onSettingsImported && window.__onSettingsImported()")
                    } else {
                        uiToast("잘못된 설정 파일입니다")
                    }
                } catch (e: Exception) {
                    uiToast("가져오기 실패: ${e.message}")
                }
            }
        }

    // ── 서비스 상태 수신 → JS로 전달 ──
    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ShareService.ACTION_STATE) {
                pushServiceState()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        locationRepo = LocationRepository(this)

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }
        WebView.setWebContentsDebuggingEnabled(false)
        webView.webViewClient = android.webkit.WebViewClient()
        webView.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                runOnUiThread {
                    val wants = request.resources.any {
                        it == android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE
                    }
                    if (wants && hasPerm(Manifest.permission.CAMERA)) {
                        request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        request.deny()
                        if (wants) {
                            uiToast("카메라 권한이 필요합니다")
                            requestPermissionFromJs("camera")
                        }
                    }
                }
            }
        }
        webView.addJavascriptInterface(WebBridge(this, prefs), "Bridge")
        webView.loadUrl("file:///android_asset/index.html")

        handleIncomingIntent(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (canBack) {
                    evalJs("window.__goBack && window.__goBack()")
                } else {
                    moveTaskToBack(true)
                }
            }
        })

        // 자동 그룹 시작
        if (prefs.autoStartGroup && hasFineLocation()) {
            ShareService.start(this, true)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
        // 앱이 이미 떠 있으면 즉시 JS에 알림
        if (pendingSharedText.isNotEmpty()) {
            evalJs("window.__onSharedText && window.__onSharedText()")
        }
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (!text.isNullOrBlank()) pendingSharedText = text
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(ShareService.ACTION_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(stateReceiver, filter)
        }
    }

    override fun onStop() {
        super.onStop()
        try {
            unregisterReceiver(stateReceiver)
        } catch (_: Exception) {
        }
    }

    // ============================================================
    // WebBridge에서 호출하는 공개 메서드
    // ============================================================

    fun evalJs(js: String) {
        runOnUiThread {
            try {
                webView.evaluateJavascript(js, null)
            } catch (_: Exception) {
            }
        }
    }

    // ============================================================
    // Firebase 실시간 스트림 (SSE) — 변경 발생 시 즉시 그룹 갱신 푸시.
    // 폴링이 아니라 푸시라 배터리/즉시성에 유리. 화면이 안 보이면 끊는다.
    // ============================================================
    @Volatile private var streamRunning = false
    private var streamConn: HttpURLConnection? = null
    private var lastSnapshotMs = 0L

    fun startFirebaseStream() {
        if (streamRunning) return
        if (prefs.backendMode != "firebase") return
        val fb = prefs.firebaseUrl
        val group = prefs.groupCode
        if (fb.isBlank() || group.isBlank()) return
        streamRunning = true
        thread(name = "fb-sse") {
            try {
                val url = URL(RelayClient.firebaseStreamUrl(fb, group))
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    setRequestProperty("Accept", "text/event-stream")
                    connectTimeout = 10000
                    readTimeout = 0            // 스트리밍: 읽기 타임아웃 없음
                }
                streamConn = conn
                if (conn.responseCode !in 200..299) { streamRunning = false; return@thread }
                conn.inputStream.bufferedReader().use { reader ->
                    var isChange = false
                    while (streamRunning) {
                        val line = reader.readLine() ?: break
                        when {
                            line.startsWith("event:") -> {
                                val ev = line.substring(6).trim()
                                isChange = (ev == "put" || ev == "patch")
                            }
                            line.startsWith("data:") -> {
                                val d = line.substring(5).trim()
                                if (isChange && d != "null") pushSnapshotThrottled()
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                // 연결 끊김/취소 — 조용히 종료. JS의 저빈도 폴백 폴링이 이어받는다.
            } finally {
                try { streamConn?.disconnect() } catch (_: Exception) {}
                streamConn = null
                streamRunning = false
            }
        }
    }

    fun stopFirebaseStream() {
        streamRunning = false
        try { streamConn?.disconnect() } catch (_: Exception) {}
        streamConn = null
    }

    private fun pushSnapshotThrottled() {
        val now = System.currentTimeMillis()
        if (now - lastSnapshotMs < 1500) return     // 연속 변경 합치기
        lastSnapshotMs = now
        val snap = RelayClient.fetchFirebase(prefs.firebaseUrl, prefs.groupKey, prefs.groupCode)
        evalJs("window.__onGroup && window.__onGroup('stream', ${quoteJs(RelayClient.snapshotToJson(snap))})")
    }

    fun uiToast(msg: String) {
        runOnUiThread {
            android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    fun setCanBack(b: Boolean) {
        canBack = b
    }

    fun copyToClipboard(text: String) {
        runOnUiThread {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("위치공유", text))
            uiToast("복사했습니다")
        }
    }

    fun shareTextChooser(text: String) {
        runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            try {
                startActivity(Intent.createChooser(send, "위치 공유"))
            } catch (e: Exception) {
                uiToast("공유 실패: ${e.message}")
            }
        }
    }

    fun openExternalMaps(lat: Double, lng: Double) {
        runOnUiThread {
            val uri = Uri.parse("https://www.google.com/maps/search/?api=1&query=$lat,$lng")
            val i = Intent(Intent.ACTION_VIEW, uri)
            try {
                startActivity(i)
            } catch (e: Exception) {
                uiToast("지도 앱을 열 수 없습니다")
            }
        }
    }

    /** 티맵 앱으로 해당 좌표 열기. 미설치 시 스토어로 안내. */
    fun openTmapApp(lat: Double, lng: Double, name: String) {
        runOnUiThread {
            val nm = Uri.encode(if (name.isBlank()) "공유 위치" else name)
            val scheme = "tmap://route?goalname=$nm&goalx=$lng&goaly=$lat"
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(scheme)))
            } catch (e: Exception) {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.skt.tmap.ku")))
                    uiToast("티맵이 설치되어 있지 않습니다")
                } catch (e2: Exception) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW,
                            Uri.parse("https://play.google.com/store/apps/details?id=com.skt.tmap.ku")))
                    } catch (e3: Exception) {
                        uiToast("티맵을 열 수 없습니다")
                    }
                }
            }
        }
    }

    fun consumePendingSharedText(): String {
        val t = pendingSharedText
        pendingSharedText = ""
        return t
    }

    // ── 권한 ──
    private fun hasPerm(p: String): Boolean =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun hasFineLocation(): Boolean = hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)

    fun permissionStateJson(): String {
        val fine = hasFineLocation()
        val background =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                hasPerm(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            else fine
        val notify =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                hasPerm(Manifest.permission.POST_NOTIFICATIONS)
            else true
        return JSONObject().apply {
            put("fine", fine)
            put("background", background)
            put("notify", notify)
            put("camera", hasPerm(Manifest.permission.CAMERA))
        }.toString()
    }

    private fun pushPermissions() {
        evalJs("window.__onPermissions && window.__onPermissions(${quoteJs(permissionStateJson())})")
    }

    fun requestPermissionFromJs(type: String) {
        runOnUiThread {
            when (type) {
                "location" -> locationPermLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    )
                )
                "background" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        if (!hasFineLocation()) {
                            uiToast("먼저 위치 권한을 허용하세요")
                            locationPermLauncher.launch(
                                arrayOf(
                                    Manifest.permission.ACCESS_FINE_LOCATION,
                                    Manifest.permission.ACCESS_COARSE_LOCATION
                                )
                            )
                        } else {
                            singlePermLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                        }
                    } else {
                        pushPermissions()
                    }
                }
                "notify" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        singlePermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        pushPermissions()
                    }
                }
                "camera" -> singlePermLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }

    fun openAppDetailsSettings() {
        runOnUiThread {
            try {
                val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                i.data = Uri.fromParts("package", packageName, null)
                startActivity(i)
            } catch (e: Exception) {
                uiToast("설정을 열 수 없습니다")
            }
        }
    }

    // ── 위치 ──
    fun fetchCurrentLocation(reqId: String) {
        if (!hasFineLocation() && !hasPerm(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            evalJs("window.__onLocation && window.__onLocation(${quoteJs(reqId)}, ${quoteJs(errJson("권한 없음"))})")
            return
        }
        locationRepo.getCurrent(prefs.highAccuracy) { res ->
            if (res == null) {
                evalJs("window.__onLocation && window.__onLocation(${quoteJs(reqId)}, ${quoteJs(errJson("위치를 가져오지 못했습니다"))})")
                return@getCurrent
            }
            // 공유 trail에 현재 위치도 반영
            prefs.addPoint(
                com.jfamily.mywhere.data.TrackPoint(
                    res.lat, res.lng, res.t, res.acc, res.bear, res.spd
                )
            )
            val json = JSONObject().apply {
                put("ok", true)
                put("lat", res.lat); put("lng", res.lng); put("t", res.t)
                put("acc", res.acc); put("bear", res.bear); put("spd", res.spd)
            }.toString()
            evalJs("window.__onLocation && window.__onLocation(${quoteJs(reqId)}, ${quoteJs(json)})")
        }
    }

    fun reverseGeocode(reqId: String, lat: Double, lng: Double) {
        thread {
            var address = ""
            try {
                if (Geocoder.isPresent()) {
                    val geo = Geocoder(this, Locale.KOREA)
                    @Suppress("DEPRECATION")
                    val list = geo.getFromLocation(lat, lng, 1)
                    if (!list.isNullOrEmpty()) {
                        val a = list[0]
                        address = a.getAddressLine(0) ?: buildString {
                            listOfNotNull(
                                a.adminArea, a.subAdminArea, a.locality,
                                a.thoroughfare, a.subThoroughfare
                            ).forEach { append(it).append(" ") }
                        }.trim()
                    }
                }
            } catch (_: Exception) {
            }
            if (address.isBlank()) {
                address = String.format(Locale.US, "%.5f, %.5f", lat, lng)
            }
            evalJs("window.__onGeocode && window.__onGeocode(${quoteJs(reqId)}, ${quoteJs(address)})")
        }
    }

    // ── 서비스 ──
    fun startShare(group: Boolean) {
        if (!hasFineLocation()) {
            uiToast("위치 권한이 필요합니다")
            requestPermissionFromJs("location")
            return
        }
        ShareService.start(this, group)
        pushServiceState()
    }

    fun stopShare() {
        ShareService.stop(this)
        pushServiceState()
    }

    private fun pushServiceState() {
        val json = JSONObject().apply {
            put("group", ShareService.groupRunning)
            put("track", ShareService.trackRunning)
        }.toString()
        evalJs("window.__onServiceState && window.__onServiceState(${quoteJs(json)})")
    }

    // ── 내보내기/가져오기 (JS에서 트리거) ──
    fun exportSettings() {
        runOnUiThread {
            pendingExportJson = prefs.exportJson(appVersion())
            exportLauncher.launch("mywhere_설정.json")
        }
    }

    fun importSettings() {
        runOnUiThread {
            importLauncher.launch(arrayOf("application/json", "text/plain", "*/*"))
        }
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
    } catch (e: Exception) {
        "1.0.0"
    }

    // ── 유틸 ──
    private fun errJson(msg: String): String =
        JSONObject().apply { put("ok", false); put("error", msg) }.toString()

    private fun quoteJs(s: String): String {
        val esc = s.replace("\\", "\\\\").replace("'", "\\'")
            .replace("\n", "\\n").replace("\r", "")
        return "'$esc'"
    }

    override fun onPause() {
        // 화면이 가려지면 실시간 스트림을 끊어 배터리 절약 (업로드는 ShareService가 계속).
        stopFirebaseStream()
        super.onPause()
    }

    override fun onDestroy() {
        stopFirebaseStream()
        try {
            webView.destroy()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
