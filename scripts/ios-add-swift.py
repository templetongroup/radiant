#!/usr/bin/env python3
"""
Add Swift files to the iPhone app's Xcode target.

The project is objectVersion 60, older than Xcode's synchronized folders, so a
new .swift file is invisible to the build until three entries exist in
project.pbxproj: a file reference, a build file, and a line in the target's
Sources phase. Doing that by hand for every file of the native rebuild is how
one gets missed and the build fails on a type that "clearly exists".

Usage: scripts/ios-add-swift.py App/Native/Foo.swift [App/Native/Bar.swift ...]
(paths relative to apps/ios/ios/App). Idempotent: a file already present is skipped.
"""
import hashlib, re, sys
from pathlib import Path

PBX = Path(__file__).resolve().parent.parent / 'apps/ios/ios/App/App.xcodeproj/project.pbxproj'

def uid(seed):
    return hashlib.sha1(seed.encode()).hexdigest()[:24].upper()

def main(paths):
    s = PBX.read_text()
    # the Sources phase of the App target: the one that already builds LocalModels.swift
    m = re.search(r'(/\* LocalModels\.swift in Sources \*/,\n)', s)
    if not m:
        sys.exit('could not find the Sources phase (LocalModels.swift in Sources)')
    added = []
    for rel in paths:
        name = Path(rel).name
        if f'path = {rel};' in s:
            continue
        fref, bfile = uid('ref:' + rel), uid('build:' + rel)
        s = s.replace('/* Begin PBXBuildFile section */\n',
                      f'/* Begin PBXBuildFile section */\n\t\t{bfile} /* {name} in Sources */ = {{isa = PBXBuildFile; fileRef = {fref} /* {name} */; }};\n', 1)
        s = s.replace('/* Begin PBXFileReference section */\n',
                      f'/* Begin PBXFileReference section */\n\t\t{fref} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; name = {name}; path = {rel}; sourceTree = "<group>"; }};\n', 1)
        s = s.replace(m.group(1), m.group(1) + f'\t\t\t\t{bfile} /* {name} in Sources */,\n', 1)
        added.append(rel)
    PBX.write_text(s)
    print('added:', ', '.join(added) if added else 'nothing (already present)')

if __name__ == '__main__':
    main(sys.argv[1:])
