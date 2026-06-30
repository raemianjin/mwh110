package com.jfamily.mywhere.data

/** 이동 경로의 한 점. t = epoch millis. bear/spd 는 없으면 음수. */
data class TrackPoint(
    val lat: Double,
    val lng: Double,
    val t: Long,
    val acc: Float = 0f,
    val bear: Float = -1f,
    val spd: Float = -1f
)

/** 실시간 그룹 구성원의 최신 위치. m = 멤버ID, n = 표시이름. */
data class GroupMember(
    val m: String,
    val n: String,
    val lat: Double,
    val lng: Double,
    val t: Long,
    val acc: Float = 0f,
    val bear: Float = -1f,
    val spd: Float = -1f
)

/** 그룹 조회 결과. unknown = 복호화 실패(키 없는 침입자/위조)로 추정되는 항목 수. */
data class GroupSnapshot(
    val members: List<GroupMember>,
    val unknown: Int = 0
)
