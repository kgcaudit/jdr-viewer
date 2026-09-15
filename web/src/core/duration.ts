/**
 * 녹화 길이 온전성 — 담긴 내용이 그 길이를 받쳐 주는지 가린다.
 *
 * 프로브(헤더 훑기)와 파서(전체 파싱)가 **같은 기준**을 써야 한다. 한쪽에만
 * 두면, 실기에서 72초짜리 파일이 목록에선 1분대인데 재생기에선 23시간으로
 * 잡히는 어긋남이 생긴다(영상·음성 패킷 하나가 다음 날 시각을 달고 있을 때).
 */

/**
 * 담긴 내용이 받쳐 줄 수 있는 최저 속도 — 패킷 하나에 1초.
 *
 * 주차 저속 녹화(1fps)까지 감안해도 이보다 느릴 수는 없다. 이걸 넘는 길이는
 * 녹화된 시간이 아니라 **파일에 적힌 다른 무엇**이다(파일을 닫은 시각,
 * 시동을 걸며 덧붙인 패킷 한 줄 따위).
 */
export const MIN_RATE_PER_SEC = 1;

/**
 * 이 길이를 담긴 내용이 받쳐 주는가.
 *
 * 영상 프레임 수와 전체 패킷 수 중 **큰 쪽**을 본다. 영상이 없는 파일
 * (음성만 남은 주차 녹화 등)도 패킷 수로는 가늠할 수 있기 때문이다.
 */
export function durationExceedsContent(durationMs: number, frames: number, packets: number): boolean {
  const units = Math.max(frames, packets);
  if (units < 2) return false;
  return durationMs > (units / MIN_RATE_PER_SEC) * 1000;
}

/**
 * 프레임 수로 종료 시각을 추정한다 (30fps 가정, 끊김 없음).
 *
 * durationExceedsContent가 참일 때만 쓰는 최후 방어선이다. 정상 파일은
 * 이 자리에 오지 않으므로 30fps 가정이 문제되지 않는다.
 */
export function endFromFrames(startMs: number, frames: number): number {
  return startMs + (frames > 1 ? ((frames - 1) / 30) * 1000 : 0);
}
