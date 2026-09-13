/**
 * 오디오 패킷을 **표본 자리**에 놓는 규칙. 재생과 내보내기가 같이 쓴다.
 *
 * 기기가 패킷에 찍는 시각은 표본 단위로 정확하지 않다. 8kHz 기준으로
 * 1ms가 여덟 표본인데, 시각은 ms 해상도이고 그나마 쓰는 순간의 벽시계라
 * 패킷마다 몇 ms씩 흔들린다. 이걸 시각 그대로 믿고 놓으면
 *
 *  - 앞 패킷 끝과 다음 패킷 시작 사이에 표본 몇 개짜리 **구멍**이 생기고
 *    (무음 = 파형이 0으로 뚝 떨어짐 → "지직"),
 *  - 반대로 겹치면 **덮어써서** 파형이 끊긴다.
 *
 * 두 경우 다 초당 여러 번 일어나므로 소리가 자주 깨져 들린다.
 *
 * 규칙은 하나다. **이어질 만하면 앞 패킷 끝에 붙인다.** 흔들림이라고 보기
 * 힘들 만큼 벌어졌을 때만 시각을 믿고 띄운다 — 주차 모드처럼 정말로 소리가
 * 없던 구간은 무음으로 남아야 하기 때문이다.
 */
import { AUDIO_SAMPLE_RATE } from './parser';

/** 이보다 좁은 틈은 진짜 공백이 아니라 시계 흔들림으로 본다 (8kHz에서 30ms) */
export const AUDIO_JITTER_SAMPLES = Math.round(AUDIO_SAMPLE_RATE * 0.03);

/**
 * 붙여 쓰다 이만큼 앞질러 밀리면 포기하고 명목 자리로 되돌린다 (1초).
 *
 * 시각이 통째로 어긋난 파일(예: 초 단위로만 찍혀 여러 패킷이 같은 시각)에서
 * 끝없이 밀려 영상과 벌어지는 걸 막는다.
 */
export const AUDIO_DRIFT_LIMIT = AUDIO_SAMPLE_RATE;

/**
 * 이 패킷을 실제로 놓을 표본 자리.
 *
 * @param cursor  앞 패킷이 끝난 자리(+1). 아직 아무것도 안 놓았으면 음수.
 * @param nominal 패킷 시각에서 구한 자리.
 */
export function placeSample(cursor: number, nominal: number): number {
  if (cursor < 0) return nominal;
  const drift = cursor - nominal;
  if (drift >= -AUDIO_JITTER_SAMPLES && drift <= AUDIO_DRIFT_LIMIT) return cursor;
  return nominal;
}
