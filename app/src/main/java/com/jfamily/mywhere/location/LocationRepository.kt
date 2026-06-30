package com.jfamily.mywhere.location

import android.annotation.SuppressLint
import android.content.Context
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * FusedLocationProvider 래퍼. google-services.json 불필요.
 * 단발 위치 조회용. 지속 업데이트는 ShareService가 직접 처리한다.
 */
class LocationRepository(ctx: Context) {

    private val client: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(ctx.applicationContext)

    /**
     * 단발 현재 위치. 권한은 호출 전에 확인되어 있어야 한다.
     * 콜백 인자: (lat, lng, time, accuracy, bearing, speed) 또는 실패 시 null.
     */
    @SuppressLint("MissingPermission")
    fun getCurrent(highAccuracy: Boolean, cb: (Result?) -> Unit) {
        val priority =
            if (highAccuracy) Priority.PRIORITY_HIGH_ACCURACY
            else Priority.PRIORITY_BALANCED_POWER_ACCURACY
        val req = CurrentLocationRequest.Builder()
            .setPriority(priority)
            .setMaxUpdateAgeMillis(15_000L)
            .setDurationMillis(20_000L)
            .build()
        try {
            client.getCurrentLocation(req, null)
                .addOnSuccessListener { loc ->
                    if (loc == null) {
                        // 폴백: 마지막 알려진 위치
                        client.lastLocation
                            .addOnSuccessListener { last ->
                                cb(last?.let { toResult(it) })
                            }
                            .addOnFailureListener { cb(null) }
                    } else {
                        cb(toResult(loc))
                    }
                }
                .addOnFailureListener { cb(null) }
        } catch (e: SecurityException) {
            cb(null)
        }
    }

    private fun toResult(loc: android.location.Location) = Result(
        lat = loc.latitude,
        lng = loc.longitude,
        t = if (loc.time > 0) loc.time else System.currentTimeMillis(),
        acc = if (loc.hasAccuracy()) loc.accuracy else 0f,
        bear = if (loc.hasBearing()) loc.bearing else -1f,
        spd = if (loc.hasSpeed()) loc.speed else -1f
    )

    data class Result(
        val lat: Double, val lng: Double, val t: Long,
        val acc: Float, val bear: Float, val spd: Float
    )
}
