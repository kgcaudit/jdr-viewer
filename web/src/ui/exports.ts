/** 내보내기 패널. 브라우저에서는 파일 쓰기가 곧 다운로드다. */
import type { ByteSource } from '../core/byte-source';
import type { JdrDocument } from '../core/types';
import {
  buildGpsCsv, buildGsensorCsv, buildPacketsCsv, buildSummaryJson, extractH264, extractWav,
} from '../core/export';
import { Sha256 } from '../core/sha256';
import { bytes, num } from './format';

/** 파일 전체를 청크로 읽어 해시를 낸다. 폴더 모드에서는 필요할 때만 계산한다. */
async function computeSha256(src: ByteSource, onProgress: (done: number, total: number) => void): Promise<string> {
  const hash = new Sha256();
  const CHUNK = 8 << 20;
  for (let pos = 0; pos < src.size; pos += CHUNK) {
    hash.update(await src.read(pos, CHUNK));
    onProgress(pos, src.size);
  }
  return hash.digestHex();
}

interface ExportItem {
  id: string;
  title: string;
  detail: string;
  disabled?: boolean;
  make: (onProgress: (done: number, total: number) => void) => Promise<Blob>;
}

function textBlob(s: string, type: string): Blob {
  return new Blob([s], { type });
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke가 너무 빠르면 사파리에서 저장이 취소된다
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function renderExports(
  el: HTMLElement,
  doc: JdrDocument,
  src: ByteSource,
  toast: (msg: string) => void,
  /** 폴더 모드일 때 현재 구간 파일명 — 내보내기 대상이 무엇인지 밝히기 위함 */
  segmentLabel?: string,
): void {
  const stem = doc.fileName.replace(/\.[^.]+$/, '') || 'jdr';
  const items: ExportItem[] = [
    {
      id: 'summary',
      title: '분석 요약 (JSON)',
      detail: 'SHA-256, 블록/패킷 통계, 코덱 정보',
      make: async () => textBlob(buildSummaryJson(doc), 'application/json'),
    },
    {
      id: 'gps',
      title: 'GPS (CSV)',
      detail: `${num(doc.gps.length)}행 · 십진 도 변환 포함`,
      disabled: doc.gps.length === 0,
      make: async () => textBlob(buildGpsCsv(doc), 'text/csv'),
    },
    {
      id: 'gsensor',
      title: 'G센서 (CSV)',
      detail: `${num(doc.gsensor.count)}행 · raw 및 g 환산값`,
      disabled: doc.gsensor.count === 0,
      make: async () => textBlob(buildGsensorCsv(doc), 'text/csv'),
    },
    {
      id: 'packets',
      title: '전체 패킷 목록 (CSV)',
      detail: `${num(doc.packets.count)}행 · 오프셋/태그/시각`,
      make: async () => textBlob(buildPacketsCsv(doc), 'text/csv'),
    },
    {
      id: 'wav',
      title: '음성 (WAV)',
      detail: `8kHz 모노 16bit · 약 ${bytes(doc.audio.sampleCount * 2 + 44)}`,
      disabled: doc.audio.packetCount === 0,
      make: (onProgress) => extractWav(src, doc, onProgress),
    },
  ];

  for (const v of doc.video) {
    items.push({
      id: `h264-${v.channel}`,
      title: `${v.channel === 0 ? '전방' : '후방'} 영상 (H.264 Annex-B)`,
      detail: `${num(v.frameCount)}프레임 · 재인코딩 없이 그대로 추출`,
      disabled: v.frameCount === 0,
      make: (onProgress) => extractH264(src, doc, v.channel, onProgress),
    });
  }

  el.innerHTML = `
    ${segmentLabel ? `<div class="note">내보내기는 <strong>현재 재생 중인 구간(${segmentLabel})</strong>에 대해서만 수행됩니다. 여러 구간에 걸친 병합 내보내기는 아직 없습니다.</div>` : ''}
    ${!doc.sha256 ? `<div class="export-item"><div><strong>이 구간 SHA-256</strong><span>폴더 모드에서는 자동 계산하지 않습니다 (파일 전체를 읽어야 함)</span></div><button class="btn" type="button" id="btn-hash">계산</button></div>` : ''}
    <div class="export-list">
      ${items
        .map(
          (it) => `<div class="export-item">
            <div><strong>${it.title}</strong><span>${it.detail}</span></div>
            <button class="btn" type="button" data-export="${it.id}" ${it.disabled ? 'disabled' : ''}>저장</button>
          </div>`,
        )
        .join('')}
    </div>
    <div class="note">
      내보낸 파일은 <strong>파생물</strong>입니다. 원본성 판단의 기준은 원본 JDR과 요약의 SHA-256입니다.
      <br>MP4 변환은 아직 붙이지 않았습니다 — H.264와 WAV를 따로 받아 쓰거나, 다음 단계에서 먹서를 추가합니다.
    </div>
  `;

  const ext: Record<string, string> = {
    summary: '_summary.json', gps: '_gps.csv', gsensor: '_gsensor.csv',
    packets: '_packets.csv', wav: '_audio.wav', 'h264-0': '_ch0.h264', 'h264-1': '_ch1.h264',
  };

  const hashBtn = el.querySelector<HTMLButtonElement>('#btn-hash');
  hashBtn?.addEventListener('click', async () => {
    hashBtn.disabled = true;
    try {
      const hex = await computeSha256(src, (done, total) => {
        hashBtn.textContent = `${Math.round((done / total) * 100)}%`;
      });
      doc.sha256 = hex;
      hashBtn.replaceWith(Object.assign(document.createElement('code'), {
        textContent: hex, style: 'font-size:11px;word-break:break-all;max-width:260px',
      }));
      toast('SHA-256 계산 완료');
    } catch (e) {
      hashBtn.disabled = false;
      hashBtn.textContent = '계산';
      toast(`해시 계산 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  el.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = items.find((i) => i.id === btn.dataset.export);
      if (!item) return;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '생성 중…';
      try {
        const blob = await item.make((done, total) => {
          btn.textContent = total ? `${Math.round((done / total) * 100)}%` : '생성 중…';
        });
        download(blob, stem + ext[item.id]);
        toast(`${item.title} 저장 · ${bytes(blob.size)}`);
      } catch (e) {
        toast(`내보내기 실패: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  });
}
