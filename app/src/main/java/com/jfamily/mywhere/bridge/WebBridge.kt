package com.jfamily.mywhere.bridge

import android.webkit.JavascriptInterface
import com.jfamily.mywhere.MainActivity
import com.jfamily.mywhere.data.Prefs
import com.jfamily.mywhere.location.ShareService
import com.jfamily.mywhere.net.RelayClient
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * WebView(JS) ↔ 네이티브 브리지.
 * JS에서 window.Bridge.* 로 호출. UI/권한/런처 작업은 MainActivity로 위임(메인스레드 처리).
 * Prefs 읽기/쓰기는 스레드 안전하므로 바인더 스레드에서 바로 처리.
 */
class WebBridge(
    private val act: MainActivity,
    private val prefs: Prefs
) {
    @JavascriptInterface
    fun log(s: String) {
        android.util.Log.d("MyWhere", s)
    }

    @JavascriptInterface
    fun toast(s: String) = act.uiToast(s)

    // ── 설정 ──
    @JavascriptInterface
    fun getSettings(): String {
        val o = JSONObject()
        o.put("name", prefs.myName)
        o.put("groupCode", prefs.groupCode)
        o.put("relayUrl", prefs.relayUrl)
        o.put("backendMode", prefs.backendMode)
        o.put("firebaseUrl", prefs.firebaseUrl)
        o.put("groupKey", prefs.groupKey)
        o.put("hasKey", com.jfamily.mywhere.data.Crypto.isValidKey(prefs.groupKey))
        o.put("recentWindowMin", prefs.recentWindowMin)
        o.put("updateIntervalSec", prefs.updateIntervalSec)
        o.put("minDistanceM", prefs.minDistanceM)
        o.put("highAccuracy", prefs.highAccuracy)
        o.put("autoStartGroup", prefs.autoStartGroup)
        o.put("memberId", prefs.memberId)
        return o.toString()
    }

    @JavascriptInterface
    fun saveSettings(json: String) {
        try {
            val o = JSONObject(json)
            if (o.has("name")) prefs.myName = o.optString("name")
            if (o.has("groupCode")) prefs.groupCode = o.optString("groupCode")
            if (o.has("relayUrl")) prefs.relayUrl = o.optString("relayUrl")
            if (o.has("backendMode")) prefs.backendMode = o.optString("backendMode")
            if (o.has("firebaseUrl")) prefs.firebaseUrl = o.optString("firebaseUrl")
            if (o.has("groupKey")) prefs.groupKey = o.optString("groupKey")
            if (o.has("recentWindowMin")) prefs.recentWindowMin = o.optInt("recentWindowMin", 30)
            if (o.has("updateIntervalSec")) prefs.updateIntervalSec = o.optInt("updateIntervalSec", 20)
            if (o.has("minDistanceM")) prefs.minDistanceM = o.optInt("minDistanceM", 15)
            if (o.has("highAccuracy")) prefs.highAccuracy = o.optBoolean("highAccuracy", false)
            if (o.has("autoStartGroup")) prefs.autoStartGroup = o.optBoolean("autoStartGroup", false)
        } catch (_: Exception) {
        }
    }

    /** 새 그룹 키 생성(base64url). QR로 대면 교환용. */
    @JavascriptInterface
    fun generateGroupKey(): String = com.jfamily.mywhere.data.Crypto.generateKey()

    // ── 내 이동 기록(trail) ──
    @JavascriptInterface
    fun getMyTrailJson(windowMin: Int): String {
        val pts = prefs.recentPoints(if (windowMin > 0) windowMin else prefs.recentWindowMin)
        val arr = JSONArray()
        for (p in pts) {
            arr.put(JSONObject().apply {
                put("lat", p.lat); put("lng", p.lng); put("t", p.t)
                put("acc", p.acc); put("bear", p.bear); put("spd", p.spd)
            })
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun clearTrail() = prefs.clearHistory()

    @JavascriptInterface
    fun exportSettings() = act.exportSettings()

    @JavascriptInterface
    fun importSettings() = act.importSettings()

    @JavascriptInterface
    fun setCanBack(b: Boolean) = act.setCanBack(b)

    // ── 클립보드 / 공유 / 지도 ──
    @JavascriptInterface
    fun copyText(text: String) = act.copyToClipboard(text)

    @JavascriptInterface
    fun shareText(text: String) = act.shareTextChooser(text)

    @JavascriptInterface
    fun openMaps(lat: Double, lng: Double) = act.openExternalMaps(lat, lng)

    @JavascriptInterface
    fun openTmap(lat: Double, lng: Double, name: String) = act.openTmapApp(lat, lng, name)

    @JavascriptInterface
    fun consumeSharedText(): String = act.consumePendingSharedText()

    // ── 권한 ──
    @JavascriptInterface
    fun permState(): String = act.permissionStateJson()

    @JavascriptInterface
    fun requestPermission(type: String) = act.requestPermissionFromJs(type)

    @JavascriptInterface
    fun openAppSettings() = act.openAppDetailsSettings()

    // ── 위치 ──
    @JavascriptInterface
    fun getCurrentLocation(reqId: String) = act.fetchCurrentLocation(reqId)

    @JavascriptInterface
    fun geocode(reqId: String, lat: Double, lng: Double) = act.reverseGeocode(reqId, lat, lng)

    // ── 서비스(실시간) ──
    @JavascriptInterface
    fun startGroup() = act.startShare(true)

    @JavascriptInterface
    fun stopGroup() = act.stopShare()

    @JavascriptInterface
    fun startTrack() = act.startShare(false)

    @JavascriptInterface
    fun stopTrack() = act.stopShare()

    @JavascriptInterface
    fun serviceState(): String {
        return JSONObject().apply {
            put("group", ShareService.groupRunning)
            put("track", ShareService.trackRunning)
        }.toString()
    }

    // ── 그룹 폴링 / 실시간 스트림 ──
    @JavascriptInterface
    fun pollGroup(reqId: String) {
        val backend = prefs.backendMode
        val relay = prefs.relayUrl
        val fb = prefs.firebaseUrl
        val key = prefs.groupKey
        val group = prefs.groupCode
        thread {
            val snap = RelayClient.fetchGroup(backend, relay, fb, key, group)
            act.evalJs("window.__onGroup && window.__onGroup(${quote(reqId)}, ${quote(RelayClient.snapshotToJson(snap))})")
        }
    }

    /** Firebase 실시간 스트림(SSE) 시작 — 변경 시 즉시 __onGroup('stream', ...) 푸시 */
    @JavascriptInterface
    fun startGroupStream() = act.startFirebaseStream()

    @JavascriptInterface
    fun stopGroupStream() = act.stopFirebaseStream()

    private fun quote(s: String): String {
        val esc = s.replace("\\", "\\\\").replace("'", "\\'")
            .replace("\n", "\\n").replace("\r", "")
        return "'$esc'"
    }
}
