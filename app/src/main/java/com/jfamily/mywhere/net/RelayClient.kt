package com.jfamily.mywhere.net

import com.jfamily.mywhere.data.Crypto
import com.jfamily.mywhere.data.GroupMember
import com.jfamily.mywhere.data.GroupSnapshot
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * 실시간 그룹 백엔드 클라이언트 (Cloudflare Worker / Firebase RTDB).
 *
 * 종단간(E2E) 암호화:
 *   - groupKey 가 있으면 위치 JSON 을 AES-GCM 으로 암호화해 {c:암호문} 만 올린다.
 *     → 서버/침입자는 URL·코드를 알아도 내용을 못 읽는다.
 *   - 조회 시 복호화 실패(키 없는 데이터 = 침입자/위조)는 unknown 으로 집계 → 그룹에 표시.
 *   - groupKey 가 비어 있으면 평문(하위호환).
 *
 * 어느 백엔드든 미설정/실패해도 '수동 공유(복사·붙여넣기)'는 정상 동작한다.
 */
object RelayClient {

    private const val FRESH_MS = 600_000L   // 최근 10분 이내만 노출

    private fun safeKey(s: String): String =
        s.trim().replace(Regex("[.#$\\[\\]/]"), "_").ifBlank { "_" }

    /** 업로드용 레코드 만들기: 키가 있으면 {c:암호문}, 없으면 평문 필드. */
    private fun buildRecord(
        keyB64: String, name: String,
        lat: Double, lng: Double, t: Long, acc: Float, bear: Float, spd: Float
    ): JSONObject {
        val inner = JSONObject().apply {
            put("n", name); put("lat", lat); put("lng", lng); put("t", t)
            put("acc", acc); put("bear", bear); put("spd", spd)
        }
        return if (Crypto.isValidKey(keyB64)) {
            val blob = Crypto.encrypt(keyB64, inner.toString())
            JSONObject().apply { if (blob != null) put("c", blob) }
        } else inner
    }

    // ── 업로드 (백엔드 분기) ──
    fun upload(
        backend: String, relay: String, fbUrl: String, keyB64: String,
        group: String, member: String, name: String,
        lat: Double, lng: Double, t: Long, acc: Float, bear: Float, spd: Float
    ): Boolean {
        if (group.isBlank()) return false
        val rec = buildRecord(keyB64, name, lat, lng, t, acc, bear, spd)
        if (rec.length() == 0) return false
        return if (backend == "firebase") uploadFirebase(fbUrl, group, member, rec)
        else uploadWorker(relay, group, member, rec)
    }

    // ── 조회 (백엔드 분기) ──
    fun fetchGroup(backend: String, relay: String, fbUrl: String, keyB64: String, group: String): GroupSnapshot {
        if (group.isBlank()) return GroupSnapshot(emptyList(), 0)
        return if (backend == "firebase") fetchFirebase(fbUrl, keyB64, group)
        else fetchWorker(relay, keyB64, group)
    }

    // ===================== Cloudflare Worker =====================
    private fun uploadWorker(relay: String, group: String, member: String, rec: JSONObject): Boolean {
        if (relay.isBlank()) return false
        return try {
            val body = JSONObject(rec.toString()).apply { put("g", group); put("m", member) }.toString()
            val conn = (URL("$relay/u").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; doOutput = true
                connectTimeout = 8000; readTimeout = 8000
                setRequestProperty("Content-Type", "application/json")
            }
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) { false }
    }

    private fun fetchWorker(relay: String, keyB64: String, group: String): GroupSnapshot {
        if (relay.isBlank()) return GroupSnapshot(emptyList(), 0)
        return try {
            val g = URLEncoder.encode(group, "UTF-8")
            val conn = (URL("$relay/g?g=$g").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 8000; readTimeout = 8000
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            if (code !in 200..299) return GroupSnapshot(emptyList(), 0)
            val arr: JSONArray = JSONObject(text).optJSONArray("members") ?: return GroupSnapshot(emptyList(), 0)
            val out = ArrayList<GroupMember>()
            var unknown = 0
            val now = System.currentTimeMillis()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("m")
                when (val r = decodeRecord(id, o, keyB64, now)) {
                    is Rec.Ok -> out.add(r.member)
                    Rec.Unknown -> unknown++
                    Rec.Stale -> {}
                }
            }
            GroupSnapshot(out, unknown)
        } catch (e: Exception) { GroupSnapshot(emptyList(), 0) }
    }

    // ===================== Firebase RTDB =====================
    private fun uploadFirebase(fb: String, group: String, member: String, rec: JSONObject): Boolean {
        if (fb.isBlank()) return false
        return try {
            val url = URL("$fb/mywhere/${safeKey(group)}/${safeKey(member)}.json")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "PUT"; doOutput = true
                connectTimeout = 8000; readTimeout = 8000
                setRequestProperty("Content-Type", "application/json")
            }
            conn.outputStream.use { it.write(rec.toString().toByteArray()) }
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: Exception) { false }
    }

    fun fetchFirebase(fb: String, keyB64: String, group: String): GroupSnapshot {
        if (fb.isBlank()) return GroupSnapshot(emptyList(), 0)
        return try {
            val conn = (URL("$fb/mywhere/${safeKey(group)}.json").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 8000; readTimeout = 8000
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            conn.disconnect()
            if (code !in 200..299 || text.isBlank() || text.trim() == "null") return GroupSnapshot(emptyList(), 0)
            val root = JSONObject(text)
            val out = ArrayList<GroupMember>()
            var unknown = 0
            val now = System.currentTimeMillis()
            val keys = root.keys()
            while (keys.hasNext()) {
                val id = keys.next()
                val o = root.optJSONObject(id) ?: continue
                when (val r = decodeRecord(id, o, keyB64, now)) {
                    is Rec.Ok -> out.add(r.member)
                    Rec.Unknown -> unknown++
                    Rec.Stale -> {}
                }
            }
            GroupSnapshot(out, unknown)
        } catch (e: Exception) { GroupSnapshot(emptyList(), 0) }
    }

    // ── 레코드 1건 해석: 복호화/평문/미상/만료 ──
    private sealed class Rec {
        data class Ok(val member: GroupMember) : Rec()
        object Unknown : Rec()
        object Stale : Rec()
    }

    private fun decodeRecord(id: String, o: JSONObject, keyB64: String, now: Long): Rec {
        val hasKey = Crypto.isValidKey(keyB64)
        val blob = o.optString("c", "")
        val data: JSONObject = if (blob.isNotBlank()) {
            // 암호문 → 복호화
            val plain = if (hasKey) Crypto.decrypt(keyB64, blob) else null
            plain?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return Rec.Unknown
        } else {
            // 평문 레코드: E2E 모드(키 있음)인데 평문이면 침입자/위조로 간주
            if (hasKey) return Rec.Unknown
            o
        }
        val t = data.optLong("t", 0L)
        if (now - t > FRESH_MS) return Rec.Stale
        return Rec.Ok(
            GroupMember(
                m = id,
                n = data.optString("n"),
                lat = data.optDouble("lat", 0.0),
                lng = data.optDouble("lng", 0.0),
                t = t,
                acc = data.optDouble("acc", 0.0).toFloat(),
                bear = data.optDouble("bear", -1.0).toFloat(),
                spd = data.optDouble("spd", -1.0).toFloat()
            )
        )
    }

    /** SSE 스트림용 Firebase 경로 (MainActivity 사용) */
    fun firebaseStreamUrl(fb: String, group: String): String =
        "$fb/mywhere/${safeKey(group)}.json"

    /** 스냅샷 → JS 전달용 JSON ({members:[...], unknown:N}) */
    fun snapshotToJson(snap: GroupSnapshot): String {
        val arr = JSONArray()
        for (m in snap.members) {
            arr.put(JSONObject().apply {
                put("m", m.m); put("n", m.n)
                put("lat", m.lat); put("lng", m.lng); put("t", m.t)
                put("acc", m.acc); put("bear", m.bear); put("spd", m.spd)
            })
        }
        return JSONObject().apply { put("members", arr); put("unknown", snap.unknown) }.toString()
    }
}
