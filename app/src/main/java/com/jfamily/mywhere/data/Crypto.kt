package com.jfamily.mywhere.data

import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 그룹 위치 종단간(E2E) 암호화.
 *  - 키: 256bit 랜덤. QR로만 대면 교환(네트워크에 절대 안 올라감).
 *  - 방식: AES-256-GCM. 평문 JSON → 암호문 1개 문자열(base64url(iv12 || ct+tag)).
 *  - 복호화 실패(다른 키/변조/평문)는 null → "알 수 없는 피어"로 표시된다.
 * JVM에서 왕복·변조탐지 검증 완료된 스킴.
 */
object Crypto {

    private val B64 = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    fun b64uEnc(b: ByteArray): String = Base64.encodeToString(b, B64)
    fun b64uDec(s: String): ByteArray = Base64.decode(s, B64)

    /** 새 그룹 키 생성 (base64url, 43자). */
    fun generateKey(): String {
        val k = ByteArray(32)
        SecureRandom().nextBytes(k)
        return b64uEnc(k)
    }

    fun isValidKey(keyB64: String): Boolean = try {
        b64uDec(keyB64).size == 32
    } catch (e: Exception) { false }

    /** 평문 → 암호문 문자열. 실패 시 null. */
    fun encrypt(keyB64: String, plain: String): String? {
        return try {
            val key = b64uDec(keyB64)
            if (key.size != 32) return null
            val iv = ByteArray(12)
            SecureRandom().nextBytes(iv)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            val ct = c.doFinal(plain.toByteArray(Charsets.UTF_8))
            val out = ByteArray(iv.size + ct.size)
            System.arraycopy(iv, 0, out, 0, iv.size)
            System.arraycopy(ct, 0, out, iv.size, ct.size)
            b64uEnc(out)
        } catch (e: Exception) { null }
    }

    /** 암호문 → 평문. 키 불일치/변조/형식오류 시 null. */
    fun decrypt(keyB64: String, blob: String): String? {
        return try {
            val key = b64uDec(keyB64)
            if (key.size != 32) return null
            val all = b64uDec(blob)
            if (all.size < 13) return null
            val iv = all.copyOfRange(0, 12)
            val ct = all.copyOfRange(12, all.size)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            String(c.doFinal(ct), Charsets.UTF_8)
        } catch (e: Exception) { null }
    }
}
