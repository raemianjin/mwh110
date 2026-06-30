package com.jfamily.mywhere.data

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.util.UUID

/**
 * 단일 SharedPreferences 파일(mywhere_prefs_v1)에 모든 설정 + 로컬 이동기록 저장.
 * Gson null 방어: 로드 후 항상 정규화한다.
 */
class Prefs(ctx: Context) {

    private val sp: SharedPreferences =
        ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    private val gson = Gson()

    // ── 단순 설정 ──
    var myName: String
        get() = sp.getString(K_NAME, "") ?: ""
        set(v) = sp.edit().putString(K_NAME, v).apply()

    var groupCode: String
        get() = sp.getString(K_GROUP, "") ?: ""
        set(v) = sp.edit().putString(K_GROUP, v).apply()

    var relayUrl: String
        get() = sp.getString(K_RELAY, "") ?: ""
        set(v) = sp.edit().putString(K_RELAY, v.trim().trimEnd('/')).apply()

    /** 실시간 백엔드: "worker"(Cloudflare Worker) 또는 "firebase"(Firebase RTDB) */
    var backendMode: String
        get() = sp.getString(K_BACKEND, "worker") ?: "worker"
        set(v) = sp.edit().putString(K_BACKEND, if (v == "firebase") "firebase" else "worker").apply()

    /** Firebase Realtime Database URL (예: https://proj-default-rtdb.firebaseio.com) */
    var firebaseUrl: String
        get() = sp.getString(K_FBURL, "") ?: ""
        set(v) = sp.edit().putString(K_FBURL, v.trim().trimEnd('/')).apply()

    /** 그룹 종단간 암호화 키(base64url 32바이트). QR로만 교환. 비어있으면 평문(비암호화). */
    var groupKey: String
        get() = sp.getString(K_GKEY, "") ?: ""
        set(v) = sp.edit().putString(K_GKEY, v.trim()).apply()

    /** 최근 정보 시간(분) — 이 시간 이내 점들을 선으로 이어 방향 표시 */
    var recentWindowMin: Int
        get() = sp.getInt(K_WINDOW, 30)
        set(v) = sp.edit().putInt(K_WINDOW, v.coerceIn(1, 1440)).apply()

    /** 위치 업데이트 간격(초) — 길수록 배터리 절약 */
    var updateIntervalSec: Int
        get() = sp.getInt(K_INTERVAL, 20)
        set(v) = sp.edit().putInt(K_INTERVAL, v.coerceIn(5, 600)).apply()

    /** 최소 이동 거리(m) — 이 거리 미만 이동은 무시(배터리 절약) */
    var minDistanceM: Int
        get() = sp.getInt(K_MINDIST, 15)
        set(v) = sp.edit().putInt(K_MINDIST, v.coerceIn(0, 1000)).apply()

    /** true=고정밀(GPS), false=균형(배터리 절약) */
    var highAccuracy: Boolean
        get() = sp.getBoolean(K_HIACC, false)
        set(v) = sp.edit().putBoolean(K_HIACC, v).apply()

    /** 앱 실행 시 그룹 공유 자동 시작 */
    var autoStartGroup: Boolean
        get() = sp.getBoolean(K_AUTOGROUP, false)
        set(v) = sp.edit().putBoolean(K_AUTOGROUP, v).apply()

    /** 이 기기의 고유 멤버 ID (그룹에서 자신 식별) */
    val memberId: String
        get() {
            var id = sp.getString(K_MEMBERID, null)
            if (id.isNullOrBlank()) {
                id = UUID.randomUUID().toString().substring(0, 8)
                sp.edit().putString(K_MEMBERID, id).apply()
            }
            return id
        }

    // ── 로컬 이동 기록 (내 공유 trail용) ──
    fun loadHistory(): MutableList<TrackPoint> {
        val json = sp.getString(K_HISTORY, null) ?: return mutableListOf()
        return try {
            val type = object : TypeToken<List<TrackPoint>>() {}.type
            val loaded: List<TrackPoint>? = gson.fromJson(json, type)
            (loaded ?: emptyList()).toMutableList()
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    private fun saveHistory(list: List<TrackPoint>) {
        sp.edit().putString(K_HISTORY, gson.toJson(list)).apply()
    }

    /** 점 하나 추가 + 보관 윈도우의 2배까지만 유지(메모리 절약) */
    fun addPoint(p: TrackPoint) {
        val list = loadHistory()
        list.add(p)
        val keepMs = recentWindowMin.toLong() * 60_000L * 2
        val cutoff = System.currentTimeMillis() - keepMs
        val trimmed = list.filter { it.t >= cutoff }.takeLast(2000)
        saveHistory(trimmed)
    }

    fun clearHistory() = sp.edit().remove(K_HISTORY).apply()

    /** 최근 윈도우(분) 이내 점들, 시간 오름차순 */
    fun recentPoints(windowMin: Int = recentWindowMin): List<TrackPoint> {
        val cutoff = System.currentTimeMillis() - windowMin.toLong() * 60_000L
        return loadHistory().filter { it.t >= cutoff }.sortedBy { it.t }
    }

    // ── 내보내기/가져오기 ──
    fun exportJson(versionName: String): String {
        val o = org.json.JSONObject()
        o.put("version", versionName)
        o.put("exportedAt", System.currentTimeMillis())
        o.put("name", myName)
        o.put("groupCode", groupCode)
        o.put("relayUrl", relayUrl)
        o.put("backendMode", backendMode)
        o.put("firebaseUrl", firebaseUrl)
        o.put("groupKey", groupKey)
        o.put("recentWindowMin", recentWindowMin)
        o.put("updateIntervalSec", updateIntervalSec)
        o.put("minDistanceM", minDistanceM)
        o.put("highAccuracy", highAccuracy)
        o.put("autoStartGroup", autoStartGroup)
        return o.toString(2)
    }

    fun importJson(text: String): Boolean {
        return try {
            val o = org.json.JSONObject(text)
            if (o.has("name")) myName = o.optString("name")
            if (o.has("groupCode")) groupCode = o.optString("groupCode")
            if (o.has("relayUrl")) relayUrl = o.optString("relayUrl")
            if (o.has("backendMode")) backendMode = o.optString("backendMode")
            if (o.has("firebaseUrl")) firebaseUrl = o.optString("firebaseUrl")
            if (o.has("groupKey")) groupKey = o.optString("groupKey")
            if (o.has("recentWindowMin")) recentWindowMin = o.optInt("recentWindowMin", 30)
            if (o.has("updateIntervalSec")) updateIntervalSec = o.optInt("updateIntervalSec", 20)
            if (o.has("minDistanceM")) minDistanceM = o.optInt("minDistanceM", 15)
            if (o.has("highAccuracy")) highAccuracy = o.optBoolean("highAccuracy", false)
            if (o.has("autoStartGroup")) autoStartGroup = o.optBoolean("autoStartGroup", false)
            true
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        private const val FILE = "mywhere_prefs_v1"
        private const val K_NAME = "name"
        private const val K_GROUP = "groupCode"
        private const val K_RELAY = "relayUrl"
        private const val K_BACKEND = "backendMode"
        private const val K_FBURL = "firebaseUrl"
        private const val K_GKEY = "groupKey"
        private const val K_WINDOW = "recentWindowMin"
        private const val K_INTERVAL = "updateIntervalSec"
        private const val K_MINDIST = "minDistanceM"
        private const val K_HIACC = "highAccuracy"
        private const val K_AUTOGROUP = "autoStartGroup"
        private const val K_MEMBERID = "memberId"
        private const val K_HISTORY = "history"
    }
}
