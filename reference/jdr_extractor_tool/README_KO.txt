IROAD JDR 추출 도구
===================

1. 목적
-------
역분석한 IROAD JDR 파일에서 다음 데이터를 추출합니다.

- 채널 0 영상: *_ch0.h264
- 채널 1 영상: *_ch1.h264
- 음성: *_audio.wav
- GPS: *_gps.csv
- G센서: *_gsensor.csv
- 전체 패킷 목록(선택): *_packets.csv
- 분석 요약: *_summary.txt / *_summary.json
- ffmpeg가 있으면 전/후방 MP4도 생성 가능

본 도구는 사용자가 제공한 00000000.jdr과 Viewer 정적 분석 결과를 기준으로
역분석한 코드이며 제조사의 공식 JDR 포맷 사양이 아닙니다.
다른 IROAD 기종/펌웨어의 JDR은 구조가 다를 수 있습니다.


2. Windows에서 가장 간단한 사용법
---------------------------------
Python 3를 설치한 후:

  1) jdr_extractor.py와 extract_jdr_windows.bat를 같은 폴더에 둡니다.
  2) .jdr 파일을 extract_jdr_windows.bat 위로 드래그합니다.
  3) 원본 JDR 파일 옆에 "파일명_extracted" 폴더가 생성됩니다.

BAT는 --mp4 및 --packet-csv 옵션을 사용합니다.
ffmpeg가 설치되어 있지 않아도 H.264/WAV/CSV 추출은 정상적으로 수행됩니다.


3. CMD / PowerShell 사용법
--------------------------
기본 추출:

  py -3 jdr_extractor.py 00000000.jdr

MP4와 패킷 목록까지 생성:

  py -3 jdr_extractor.py 00000000.jdr --mp4 --packet-csv

출력 폴더 지정:

  py -3 jdr_extractor.py 00000000.jdr -o C:\Temp\JDR_Output --mp4

ffmpeg.exe 위치 직접 지정:

  py -3 jdr_extractor.py 00000000.jdr --mp4 --ffmpeg C:\ffmpeg\bin\ffmpeg.exe

JDR 내부 인덱스가 조금이라도 맞지 않으면 중단:

  py -3 jdr_extractor.py 00000000.jdr --strict-index


4. MP4 생성
-----------
MP4 생성에는 ffmpeg가 필요합니다.
ffmpeg가 PATH에 등록되어 있으면 --mp4 옵션으로 자동 생성합니다.

영상은 JDR에서 추출한 H.264를 가능한 한 그대로 stream-copy하고,
음성은 MP4 호환성을 위해 AAC로 변환합니다.

ffmpeg가 없으면 다음 원본 추출물은 그대로 생성됩니다.

  *_ch0.h264
  *_ch1.h264
  *_audio.wav


5. 현재까지 확인한 JDR 구조
--------------------------
JEB1 헤더:
  - 디스크상의 magic bytes: 1BEJ
  - 헤더 크기: 0x200 (512 bytes)
  - +0x04: 패킷 수
  - +0xB8: 12-byte index table 위치
  - +0x1FC: header size sentinel 0x200

패킷 헤더: 28 bytes
  +0x00  tag[4]
  +0x04  payload size (uint32 LE)
  +0x08  aux / sequence 정보 (uint32 LE)
  +0x0C  Windows SYSTEMTIME (16 bytes)
  +0x1C  payload 시작

확인된 tag:
  00VI / 00VP : 채널 0 H.264 I/P frame
  01VI / 01VP : 채널 1 H.264 I/P frame
  xxAD         : PCM audio
  xxGP         : GPS
  xxSE         : G-sensor

12-byte index entry:
  +0x00 tag[4]
  +0x04 payload size
  +0x08 packet offset


6. 확인된 미디어/센서 형식
--------------------------
제공된 샘플 기준:

영상
  - H.264 Annex-B
  - CH0 / CH1 각각 약 30 fps
  - 샘플 해상도 1280x720

음성
  - PCM signed 16-bit little-endian
  - 8,000 Hz
  - Mono

GPS
  - GP packet 내부 binary struct
  - 위도/경도: NMEA ddmm.mmmm 형식으로 해석
  - speed 필드: km/h로 해석

G센서
  - signed int32 X/Y/Z
  - 샘플에서는 Z축 정지값이 약 1024이므로 1024 raw unit ~= 1g로 추정
  - CSV의 *_g_est 값은 이 추정치를 적용한 값임


7. 증거/감사 용도로 사용할 때
-----------------------------
원본 JDR은 별도로 보존하는 것을 권장합니다.
도구는 원본 파일을 읽기 전용으로 열며 원본을 수정하지 않습니다.

summary 파일에는 입력 JDR의 SHA-256 해시가 기록됩니다.
추출된 MP4는 재생 편의를 위한 파생물이며, 원본성 판단의 기준은 원본 JDR 및
해시값으로 두는 것이 적절합니다.

GPS/G센서 세부 필드 중 일부는 역공학을 통해 추정된 값이므로 법적/감정 용도로
사용할 경우 제조사 사양 또는 추가 샘플 검증을 병행하는 것이 좋습니다.
