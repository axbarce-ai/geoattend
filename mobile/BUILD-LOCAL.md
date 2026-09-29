Tuwing magbabago ang IP ng PC mo, kailangang i-build ulit ang app, dahil naka-embed sa APK ang server address. Ganito ang gagawin. Mga 3 minuto lang ito, dahil tapos na ang unang mahabang build.

1. Alamin ang bagong IP


ipconfig


Hanapin ang Wireless LAN adapter Wi-Fi, tapos ang IPv4 Address. Halimbawa: 192.168.254.120.

2. Burahin muna ang naka-cache na app config. Hindi napapansin ng Gradle na nagbago ang API_BASE_URL, kaya kapag nilaktawan ito, luma pa rin ang IP sa APK:


Remove-Item -Force -ErrorAction SilentlyContinue C:\geoattend-pro\mobile\node_modules\expo-constants\android\build\generated\assets\expo-constants\app.config, C:\geoattend-pro\mobile\node_modules\expo-constants\android\build\intermediates\library_assets\release\out\app.config, C:\geoattend-pro\mobile\android\app\build\intermediates\assets\release\app.config


3. I-build ulit gamit ang bagong IP. Palitan ang IP sa ikatlong linya:


$env:JAVA_HOME     = 'C:\Program Files\Android\openjdk\jdk-21.0.8'
$env:ANDROID_HOME  = "$env:LOCALAPPDATA\Android\Sdk"
$env:API_BASE_URL  = 'http://172.16.172.119:3000/api'
$env:NODE_ENV      = 'production'
cd C:\geoattend-pro\mobile\android
.\gradlew.bat assembleRelease --no-daemon --project-cache-dir C:\gcache


Hintayin ang BUILD SUCCESSFUL.

4. Ilagay ang APK sa download folder


Copy-Item C:\geoattend-pro\mobile\android\app\build\outputs\apk\release\app-release.apk C:\geoattend-pro\public\downloads\GeoAttend-Local.apk -Force


5. I-download sa phone gamit ang bagong IP
http://172.16.172.119:3000/downloads/GeoAttend-Local.apk

I-install ito nang patong sa dati. Hindi na kailangang i-uninstall, at hindi na rin kailangang i-approve ulit ang device.

Hindi mo na kailangang ulitin ang expo prebuild. Walang epekto rin ito sa Office Network (Allowed IPs) sa Settings, dahil ang public IP ng internet line ang tinitingnan doon, hindi ang IP ng PC.

Para hindi na ito maulit, dalawa ang pagpipilian mo:

1. I-fix ang IP ng PC sa router (DHCP reservation). Sa router admin page, na kadalasan ay 192.168.254.254 o 192.168.1, i-reserve ang 192.168.254.107 para sa PC mo. Hindi na magbabago ang IP, at hindi na kailangang i-rebuild.

2. Maglagay ng "Server address" setting sa app. Kaya kong magdagdag ng field sa login screen kung saan puwedeng palitan ang IP nang hindi nire-rebuild ang APK. Isang huling rebuild na lang ang kailangan pagkatapos nito.