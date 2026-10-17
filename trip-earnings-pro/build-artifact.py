"""Builds dist/artifact.html: the same app as public/index.html but as a single file for hosting on
claude.ai artifacts (a demo host whose sandbox blocks service workers, GPS, microphone and Supabase
network calls). The real deployment is the public/ folder."""
import re, pathlib
P = pathlib.Path(__file__).parent / 'public'
html = (P / 'index.html').read_text()
body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
head = re.search(r'<head>(.*)</head>', html, re.S).group(1)
style = re.search(r'<style>.*?</style>', head, re.S).group(0)
fonts = re.search(r'<link rel="stylesheet"[^>]+>', head).group(0)
scripts = ''.join(f'<script>\n{(P / f).read_text()}\n</script>\n' for f in ('core.js', 'sync.js', 'app.js'))
body = re.sub(r'<script src="[^"]+"></script>\s*', '', body)
banner = ('<div class="card" style="border-color:var(--gold);margin:12px auto 0;max-width:720px;font-size:13px;line-height:1.5">'
          '<b>Demo copy on claude.ai.</b> Trips, tips, targets, achievements, history, insights and import/export all work here and stay in this browser. '
          'This host blocks GPS, the microphone and cloud sync, so Drive mode and Google sign-in only work on your own HTTPS deployment '
          '(see README.md: drag the <code>public/</code> folder onto Netlify Drop).</div>')
body = body.replace('<main>', '<main>' + banner, 1)
out = f'<title>Trip Earnings Pro</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n{fonts}\n{style}\n{body}\n{scripts}'
(pathlib.Path(__file__).parent / 'dist' / 'artifact.html').write_text(out)
print('dist/artifact.html', len(out), 'bytes')
