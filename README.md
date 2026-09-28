# Naxsim E-Sports

Mobil öncelikli Among Us topluluğu, oda sohbeti ve turnuva yönetimi. Uygulama Node.js, Express, Socket.IO ve better-sqlite3 kullanır; arayüz saf HTML, CSS ve JavaScript'tir.

## Gereksinimler

- Node.js 20 veya üstü
- npm

## Yerelde çalıştırma

```powershell
npm install
Copy-Item .env.example .env
```

`.env` dosyasında `JWT_SECRET` değerini en az 32 karakterlik rastgele bir değerle, `ADMIN_PASSWORD` değerini güçlü bir şifreyle değiştir. Ardından:

```powershell
npm start
```

Uygulama `http://localhost:3000` adresinde açılır. Geliştirme için `npm run dev` kullanılabilir. SQLite veritabanı ilk başlatmada `naxsim.db` dosyasına oluşturulur; bu dosya Git'e eklenmez.

Bu çalışma alanında yerel `.env` için 256-bit rastgele bir `JWT_SECRET` üretildi. Gizli anahtarı paylaşma veya Git'e ekleme; anahtarı değiştirirsen mevcut JWT oturumları geçersiz olur. `.env.example` yalnızca örnek/placeholder değer içerir.

## Temel akışlar

- Hesap oluşturma/giriş: bcrypt şifre özeti, 30 günlük JWT ve `httpOnly`, `sameSite=strict` cookie.
- Canlı sohbet: `genel`, `turnuva` ve `lobi` odaları; socket bağlantısı JWT ile doğrulanır. Mesajlarda 2 saniye bekleme, 10 saniyede 5 mesaj sınırı ve bağlantı filtresi uygulanır.
- Turnuvalar: oluşturma, katılma, ayrılma, sahibi/admin tarafından kazanan belirleme ve sıralama puanları.
- Rozetler: üye kaydında; şampiyon ve sezon şampiyonu turnuva sonuçlarında otomatik verilir. Admin hesabı ortam değişkenleriyle ilk çalıştırmada oluşturulur.
- Yetkiler: admin tüm yönetim API'lerine; mod yalnızca 7 güne kadar ban API'sine erişebilir. Yetki denetimleri sunucudadır.
- Admin paneli: oyuncu arama/sayfalama, rol değiştirme, ban/unban, onaylı hesap silme, ban geçmişi, turnuva iptal/yeniden açma, canlı duyuru ve yönetim logları. Hesap silmede admin hesapları korunur; kullanıcının turnuvaları işlemi yapan admin'e aktarılır.
- Giriş koruması: 3 başarısız girişten sonra IP'ye bağlı, tek kullanımlık CAPTCHA; 10 başarısız girişten sonra IP 15 dakika boyunca tüm API ve Socket.IO bağlantılarında engellenir. Denemeler ve bloklar veritabanında HMAC'lenmiş IP özetiyle tutulur; CAPTCHA yanıtları HMAC özeti olarak saklanır.
- Giriş kaynağı/anti-bot: HTML sayfa isteklerinde `Referer` alan adı yalnızca o HTTP isteği boyunca okunur; kaynağı, tam Referer URL'sini veya IP'yi veritabanına/loga yazmayız ve harici IP itibar servisine göndermeyiz. Bilinen otomasyon istemcileri `/blocked` sayfasına yönlendirilir; insan gezinmesi `/` uygulama girişine yönlendirilir. CSS/JS/API/socket istekleri bu sayfa filtresinden etkilenmez. `Referer` sahte olabilir veya tarayıcı tarafından hiç gönderilmeyebilir; tek başına kimlik/güvenlik kanıtı değildir. Login CAPTCHA'sı ayrı koruma katmanı olarak kalır.
- Ban ekranı: `/banned.html` yalnızca halen banlı olan hesaba ait geçerli oturum veya kısa yetkili ban-bildirimi cookie'siyle açılır. Banlı hesaplar tüm giriş sayfalarından buraya yönlendirilir ve normal API işlemleri `403` alır; banı sona eren veya hiç banlanmamış hesaplar ana sayfaya döner. Sayfada işlem formu/aksiyonu yoktur.
- Veritabanı koruması: SQLite foreign key, `trusted_schema=OFF`, `secure_delete=ON`, `synchronous=FULL`, 5 saniyelik busy timeout, WAL ve kritik sorgular için indeksler kullanır. POSIX sistemlerde ana DB dosyası için izinler `0600` yapılır; `.db`, WAL ve SHM dosyaları Git dışında tutulur.
- Diğer savunmalar: Helmet CSP, izin listeli CORS, API/login/register/turnuva hız sınırları, parametreli SQLite sorguları ve boyut sınırlandırılmış JSON gövdesi.

## Ortam değişkenleri

| Değişken | Açıklama |
| --- | --- |
| `PORT` | HTTP portu (varsayılan `3000`) |
| `NODE_ENV` | `production` modunda secure cookie ve HTTPS CSP kullanılır |
| `JWT_SECRET` | JWT imza anahtarı, en az 32 karakter |
| `CLIENT_ORIGIN` | İzin verilen istemci origin'i |
| `ADMIN_USERNAME` | İlk çalıştırmada admin hesabı oluşturur; isim normal kullanıcıya aitse sunucu güvenli biçimde başlamaz |
| `ADMIN_PASSWORD` | İlk admin oluşturulurken kullanılan şifre |
| `COOKIE_SECURE` | HTTPS ortamında `true` olmalı |
| `TRUST_PROXY` | Reverse proxy sayısı; yalnızca proxy arkasında doğru hop sayısıyla ayarla (varsayılan `0`) |

CAPTCHA ve IP blok eşikleri sırasıyla 3/10 başarısız giriş, blok süresi 15 dakika ve CAPTCHA süresi 5 dakikadır. CAPTCHA üretim endpoint'i ayrıca hız limitlidir. Render gibi reverse proxy arkasında `TRUST_PROXY=1` kullan; yalnızca kendi kontrolündeki proxy katmanı kadar güven.

Render üzerinde kalıcı SQLite disk kullanılamaz. Yayına almadan önce veritabanı katmanını PostgreSQL'e taşı, Render environment variables üzerinden sırları tanımla, HTTPS kullan ve `CLIENT_ORIGIN` değerini gerçek alan adıyla sınırla. Bu başlangıç uygulaması PostgreSQL adaptörünü içermez.

Kod güncellendikten sonra çalışan Node sunucusunu yeniden başlat. Eski süreçler bellekte eski API rotalarını tutabilir ve yeni UI isteklerine `API endpoint bulunamadı` yanıtı verebilir.

## Test

```powershell
npm test
```