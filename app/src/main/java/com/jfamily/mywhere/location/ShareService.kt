package com.jfamily.mywhere.location

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.jfamily.mywhere.MainActivity
import com.jfamily.mywhere.R
import com.jfamily.mywhere.data.Prefs
import com.jfamily.mywhere.data.TrackPoint
import com.jfamily.mywhere.net.RelayClient
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * 배터리 최소화 실시간 위치 서비스.
 * - track 모드: 로컬 이동기록만 (네트워크 없음)
 * - group 모드: 로컬 기록 + 릴레이 업로드 (실시간 그룹 공유)
 * group 모드는 track을 포함한다.
 *
 * 배터리 절약: 기본 BALANCED 우선순위 + 사용자 지정 간격/최소 이동거리,
 * setWaitForAccurateLocation(false), setMinUpdateIntervalMillis 적용.
 */
class ShareService : Service() {

    private lateinit var prefs: Prefs
    private var fused: FusedLocationProviderClient? = null
    private var callback: LocationCallback? = null
    private var lastUpdateText: String = "위치 대기 중"

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        fused = LocationServices.getFusedLocationProviderClient(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopUpdates()
                stopForegroundCompat()
                stopSelf()
                broadcastState()
                return START_NOT_STICKY
            }
            else -> {
                val group = intent?.getBooleanExtra(EXTRA_GROUP, false) ?: false
                groupRunning = group
                trackRunning = true
                startForegroundCompat()
                startUpdates()
                broadcastState()
            }
        }
        return START_STICKY
    }

    @SuppressLint("MissingPermission")
    private fun startUpdates() {
        stopUpdates()
        val intervalMs = prefs.updateIntervalSec.toLong() * 1000L
        val priority =
            if (prefs.highAccuracy) Priority.PRIORITY_HIGH_ACCURACY
            else Priority.PRIORITY_BALANCED_POWER_ACCURACY

        val req = LocationRequest.Builder(priority, intervalMs)
            .setMinUpdateIntervalMillis((intervalMs / 2).coerceAtLeast(5000L))
            .setMinUpdateDistanceMeters(prefs.minDistanceM.toFloat())
            .setWaitForAccurateLocation(false)
            .build()

        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val loc = result.lastLocation ?: return
                handleLocation(loc)
            }
        }
        callback = cb
        try {
            fused?.requestLocationUpdates(req, cb, Looper.getMainLooper())
        } catch (e: SecurityException) {
            lastError = "위치 권한 없음"
        }
    }

    private fun handleLocation(loc: android.location.Location) {
        val now = if (loc.time > 0) loc.time else System.currentTimeMillis()
        val p = TrackPoint(
            lat = loc.latitude,
            lng = loc.longitude,
            t = now,
            acc = if (loc.hasAccuracy()) loc.accuracy else 0f,
            bear = if (loc.hasBearing()) loc.bearing else -1f,
            spd = if (loc.hasSpeed()) loc.speed else -1f
        )
        prefs.addPoint(p)

        lastUpdateText = "최근 갱신 " + SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(Date(now))
        updateNotification()

        if (groupRunning) {
            val backend = prefs.backendMode
            val relay = prefs.relayUrl
            val fb = prefs.firebaseUrl
            val group = prefs.groupCode
            val name = prefs.myName.ifBlank { "익명" }
            val member = prefs.memberId
            val ready = group.isNotBlank() &&
                (if (backend == "firebase") fb.isNotBlank() else relay.isNotBlank())
            if (ready) {
                thread {
                    RelayClient.upload(
                        backend, relay, fb, prefs.groupKey, group, member, name,
                        p.lat, p.lng, p.t, p.acc, p.bear, p.spd
                    )
                }
            }
        }
    }

    private fun stopUpdates() {
        callback?.let { fused?.removeLocationUpdates(it) }
        callback = null
    }

    // ── 포그라운드 알림 ──
    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel(
                CHANNEL_ID, "위치 공유",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "실시간 위치 공유 진행 상태" }
            mgr.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        val title = if (groupRunning) "실시간 그룹 공유 중" else "이동 기록 중"
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(lastUpdateText)
            .setSmallIcon(R.drawable.notif_icon)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .build()
    }

    private fun startForegroundCompat() {
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun updateNotification() {
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.notify(NOTIF_ID, buildNotification())
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun broadcastState() {
        val i = Intent(ACTION_STATE).apply {
            setPackage(packageName)
            putExtra("group", groupRunning)
            putExtra("track", trackRunning)
        }
        sendBroadcast(i)
    }

    override fun onDestroy() {
        stopUpdates()
        groupRunning = false
        trackRunning = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val CHANNEL_ID = "mywhere_share"
        const val NOTIF_ID = 1001
        const val ACTION_START = "com.jfamily.mywhere.START"
        const val ACTION_STOP = "com.jfamily.mywhere.STOP"
        const val ACTION_STATE = "com.jfamily.mywhere.STATE"
        const val EXTRA_GROUP = "group"

        @Volatile var groupRunning: Boolean = false
        @Volatile var trackRunning: Boolean = false
        @Volatile var lastError: String = ""

        fun start(ctx: Context, group: Boolean) {
            val i = Intent(ctx, ShareService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_GROUP, group)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun stop(ctx: Context) {
            val i = Intent(ctx, ShareService::class.java).apply { action = ACTION_STOP }
            ctx.startService(i)
        }
    }
}
