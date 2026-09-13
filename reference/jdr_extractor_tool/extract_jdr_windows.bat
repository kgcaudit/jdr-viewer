@echo off
setlocal
chcp 65001 >nul

set "SCRIPT=%~dp0jdr_extractor.py"

if not exist "%SCRIPT%" (
  echo [오류] jdr_extractor.py 파일을 찾을 수 없습니다.
  pause
  exit /b 1
)

if "%~1"=="" (
  echo JDR 파일을 이 BAT 파일 위로 드래그해서 실행하거나,
  set /p "JDR=JDR 파일 전체 경로를 입력하세요: "
) else (
  set "JDR=%~1"
)

if not exist "%JDR%" (
  echo [오류] 파일을 찾을 수 없습니다: %JDR%
  pause
  exit /b 1
)

where py >nul 2>&1
if %errorlevel%==0 (
  py -3 "%SCRIPT%" "%JDR%" --mp4 --packet-csv
) else (
  where python >nul 2>&1
  if %errorlevel%==0 (
    python "%SCRIPT%" "%JDR%" --mp4 --packet-csv
  ) else (
    echo [오류] Python 3가 설치되어 있지 않습니다.
    echo Python 3 설치 후 다시 실행하세요.
    pause
    exit /b 1
  )
)

if errorlevel 1 (
  echo.
  echo [오류] 추출 중 문제가 발생했습니다.
) else (
  echo.
  echo 완료되었습니다. JDR 파일 옆의 *_extracted 폴더를 확인하세요.
  echo ffmpeg가 PATH에 설치되어 있으면 MP4도 함께 생성됩니다.
)

pause
endlocal
