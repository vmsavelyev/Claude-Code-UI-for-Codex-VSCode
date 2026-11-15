#!/usr/bin/env python3
"""Собирает локальную надстройку VS Code без установки пакетов."""

import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape


def main():
    bundle = Path(__file__).resolve().parent
    selection = json.loads((bundle / 'bundle.json').read_text())
    version = selection['uiVersion']
    release = bundle / 'releases' / selection['release']
    source = release / 'src'
    package = json.loads((source / 'package.json').read_text())
    if package['version'] != version:
        raise SystemExit('Версия исходников отличается от версии комплекта.')
    metadata = json.loads((release / 'release.json').read_text())
    metadata['uiVersion'] = version
    metadata['vsix'] = 'codex-history-ui-' + selection['release'] + '.vsix'
    (release / 'release.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    manifest = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="codex-history-ui" Version="{version}" Publisher="slava-local"/><DisplayName>Codex History UI</DisplayName><Description xml:space="preserve">Локальный интерфейс Codex: история, аккаунт и индикаторы.</Description><Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="openai.chatgpt"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>'''.format(version=escape(version), engine=escape(package['engines']['vscode']))
    content_types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'''
    with ZipFile(release / metadata['vsix'], 'w', ZIP_DEFLATED) as archive:
        archive.writestr('extension.vsixmanifest', manifest)
        archive.writestr('[Content_Types].xml', content_types)
        for file in sorted(source.iterdir()):
            if file.is_file() and not file.name.startswith('.'):
                archive.write(file, 'extension/' + file.name)
    checksums = {
        str(file.relative_to(release)): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in sorted(release.rglob('*')) if file.is_file() and file.name not in ('checksums.json', '.DS_Store')
    }
    (release / 'checksums.json').write_text(json.dumps(checksums, indent=2) + '\n')
    print(release / metadata['vsix'])


if __name__ == '__main__':
    main()
