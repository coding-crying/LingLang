"""Render the shared Markdown guide for the website (pip install markdown)."""
from pathlib import Path
import markdown

root = Path(__file__).resolve().parent
body = markdown.markdown((root / 'first-time-setup.md').read_text(), extensions=['fenced_code'])
page = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>First-time setup · LingLang</title>
<meta name="description" content="Getting started with LingLang: hosted access, Google and BYO providers, self-hosting preview status, backups and troubleshooting.">
<link rel="canonical" href="https://linglang.app/docs/">
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#17191c;color:#eee}
*{box-sizing:border-box}body{margin:0;line-height:1.7}header,main,footer{max-width:860px;margin:auto;padding:24px}
header{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #42454b}
a{color:#ffa67e;text-underline-offset:3px}a:hover{color:#ffd0b8}a:focus-visible{outline:3px solid #ffa67e;outline-offset:4px}
h1{font-size:clamp(2rem,6vw,3.2rem);line-height:1.15}h2{margin-top:2.5rem;color:#ffac89;line-height:1.3}h3{margin-top:1.8rem}
p,li{overflow-wrap:anywhere}li{margin:.5rem 0}code{background:#2b2e34;padding:2px 5px;border-radius:4px;font-size:.9em}pre{overflow:auto;background:#2b2e34;padding:16px}
footer{border-top:1px solid #42454b;color:#bbb;font-size:.9rem}.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:16px;background:#17191c;padding:12px}
</style></head><body><a class="skip" href="#content">Skip to content</a>
<header><a href="/">LingLang</a><nav aria-label="Documentation"><a href="https://dashboard.linglang.app">Dashboard</a> · <a href="https://github.com/coding-crying/LingLang/blob/main/docs/first-time-setup.md">GitHub guide</a></nav></header>
<main id="content">''' + body + '''</main><footer>Developer-preview limitations are listed explicitly. A working login page is not proof of a complete voice installation.</footer></body></html>'''
out = root / 'site' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(page)
print(out)
