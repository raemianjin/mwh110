# 위치공유(myWhere) 실시간 그룹 릴레이 — 배포 가이드

실시간 그룹 공유 모드는 작은 중계 서버(릴레이)가 하나 필요합니다.
Cloudflare Worker로 **무료·무제한에 가깝게** 5분이면 띄울 수 있습니다.
(수동 공유 — 카카오톡 복사·붙여넣기 — 는 릴레이 없이도 항상 동작합니다.)

## 동작 방식
- 각자 앱이 정해진 간격으로 자기 위치를 `POST /u` 로 올립니다.
- 앱이 `GET /g?g=그룹코드` 로 같은 그룹 사람들의 최신 위치를 받아 지도에 표시합니다.
- 위치는 **15분 뒤 자동 삭제**되고, 조회 시 **최근 10분 이내**만 보입니다. (서버에 오래 안 남음)

## 배포 순서

1. Node.js 설치 후, Cloudflare 계정으로 로그인
   ```
   npm install -g wrangler
   wrangler login
   ```

2. KV 네임스페이스 생성 (위치 저장소)
   ```
   wrangler kv namespace create MYWHERE
   ```
   출력된 `id = "...."` 값을 `wrangler.toml` 의 id 자리에 붙여넣습니다.

3. 배포
   ```
   wrangler deploy
   ```
   끝나면 `https://mywhere-relay.<계정>.workers.dev` 주소가 나옵니다.

4. 앱 → 설정 → **릴레이 URL** 에 그 주소를 그대로 입력하고 저장.
   가족 모두 **같은 릴레이 URL + 같은 그룹 코드**를 쓰면 됩니다.

## 보안 메모
- 인증이 없으므로 **그룹 코드가 곧 비밀번호**입니다. `family-3f9k2` 처럼 추측하기 어려운 코드를 쓰세요.
- 더 강한 보안이 필요하면 worker.js 에 공유 토큰 검사를 추가할 수 있습니다.

## 엔드포인트 계약 (참고)
```
POST /u   {g,m,n,lat,lng,t,acc,bear,spd}     → {ok:true}
GET  /g?g=그룹코드                            → {members:[{m,n,lat,lng,t,acc,bear,spd}, ...]}
```
