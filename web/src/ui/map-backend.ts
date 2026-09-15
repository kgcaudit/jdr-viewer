/**
 * 지도 백엔드 공통 인터페이스.
 *
 * 같은 표면을 Leaflet(OSM) 과 카카오 두 구현이 만족한다. GpsMap 파사드가 실행
 * 환경에 맞는 백엔드를 골라 이 인터페이스로만 부린다. 호출부는 어느 지도인지 모른다.
 */
import type { GpsFix } from '../core/types';
import type { Stay } from '../core/stays';

export interface MapBackend {
  /** GPS 경로·표식을 그린다. @returns 표시/제외 개수 */
  render(fixes: GpsFix[]): { shown: number; dropped: number };
  /** 재생 위치(벽시계 ms)에 맞춰 표식을 옮기고 그 점을 돌려준다 */
  syncTo(absTimeMs: number): GpsFix | null;
  /** 지금 지점이 보이게 화면을 옮긴다 (누를 때만) */
  showCurrent(): GpsFix | null;
  /** 전체 경로가 다 보이게 맞춘다 */
  fitAll(): boolean;
  /** 다음 render 때 다시 화면을 맞추게 한다 */
  resetFit(): void;
  /** 숨겨진 채 만들어졌으면 크기를 다시 잰다 */
  invalidate(): void;
  /** 경로에 시각을 붙인다 (눌러서 그 점 시각, 시작·끝엔 라벨) */
  enableTimeLabels(fmt: (ms: number) => string, extra?: (g: GpsFix) => string): void;
  /** 머문 곳(체류)을 표식으로 표기한다 */
  showStays(stays: Stay[], fmtClock: (ms: number) => string, fmtDur: (ms: number) => string): void;
}
