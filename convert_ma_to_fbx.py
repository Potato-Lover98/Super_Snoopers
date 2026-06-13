#!/usr/bin/env mayapy
"""
Convert a Maya ASCII (.ma) file to FBX.

IMPORTANT: .ma is a Maya-only format. There is NO pure-Python parser for it,
and Blender cannot import it either. The ONLY reliable converter is Autodesk
Maya itself. This script therefore must be run with **mayapy** — the Python
interpreter that ships free inside every Maya install — NOT regular python3.

Usage:
    mayapy convert_ma_to_fbx.py <input.ma> [output.fbx]

Find mayapy:
    Linux : /usr/autodesk/maya<ver>/bin/mayapy
    macOS : /Applications/Autodesk/maya<ver>/Maya.app/Contents/bin/mayapy
    Win   : "C:\\Program Files\\Autodesk\\Maya<ver>\\bin\\mayapy.exe"

Example:
    /usr/autodesk/maya2024/bin/mayapy convert_ma_to_fbx.py \\
        assets/player/uploads_files_5425568_ProtoMannequin_RIG_V1.ma \\
        assets/player/player.fbx

No Maya installed? See the notes at the bottom of this file for alternatives.
"""

import os
import sys


def convert(in_path, out_path):
    import maya.standalone
    maya.standalone.initialize(name="python")

    import maya.cmds as cmds
    import maya.mel as mel

    # FBX exporter lives in a plugin — load it
    if not cmds.pluginInfo("fbxmaya", q=True, loaded=True):
        cmds.loadPlugin("fbxmaya")

    print("[*] opening:", in_path)
    cmds.file(in_path, open=True, force=True, ignoreVersion=True, prompt=False)

    # FBX export options (geometry + skin + anim, embedded textures, binary FBX 2020)
    mel.eval('FBXResetExport')
    mel.eval('FBXExportFileVersion -v FBX202000')
    mel.eval('FBXExportInputConnections -v false')
    mel.eval('FBXExportSmoothingGroups -v true')
    mel.eval('FBXExportSmoothMesh -v true')
    mel.eval('FBXExportTangents -v true')
    mel.eval('FBXExportSkins -v true')
    mel.eval('FBXExportShapes -v true')
    mel.eval('FBXExportSkeletonDefinitions -v true')
    mel.eval('FBXExportAnimationOnly -v false')
    mel.eval('FBXExportBakeComplexAnimation -v true')
    mel.eval('FBXExportEmbeddedTextures -v true')
    mel.eval('FBXExportInAscii -v false')   # binary = smaller, three.js loads it

    out_path = out_path.replace("\\", "/")
    print("[*] exporting:", out_path)
    # path must be MEL-escaped; forward slashes are fine on all OSes for FBX
    mel.eval('FBXExport -f "{}" -s'.format(out_path))   # -s = whole scene

    print("[✓] done:", out_path)

    try:
        maya.standalone.uninitialize()
    except Exception:
        pass


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    in_path = os.path.abspath(args[0])
    if not in_path.lower().endswith(".ma"):
        print("ERROR: input must be a .ma file:", in_path)
        sys.exit(1)
    if not os.path.isfile(in_path):
        print("ERROR: file not found:", in_path)
        sys.exit(1)

    out_path = os.path.abspath(args[1]) if len(args) > 1 \
        else os.path.splitext(in_path)[0] + ".fbx"

    try:
        import maya.standalone  # noqa: F401
    except ImportError:
        sys.stderr.write(
            "\nERROR: this is not running inside Maya's Python (mayapy).\n"
            "`import maya` failed — regular python3 cannot read .ma files.\n\n"
            "Run it with mayapy instead, e.g.:\n"
            "  /usr/autodesk/maya2024/bin/mayapy convert_ma_to_fbx.py "
            "<input.ma> <output.fbx>\n\n"
            "No Maya? See the alternatives in the comment block at the\n"
            "bottom of this script.\n"
        )
        sys.exit(2)

    convert(in_path, out_path)


if __name__ == "__main__":
    main()


# ---------------------------------------------------------------------------
# NO MAYA INSTALLED? Three realistic options:
#
# 1. Free Maya trial (30 days) or a student/education license from
#    autodesk.com — install it, then `mayapy` is at the path shown above.
#
# 2. Ask whoever produced the .ma to "File > Export All" as .fbx (or .obj /
#    .glb). This is a 10-second job inside Maya and avoids the whole problem.
#
# 3. Online converters (e.g. products that accept Maya files) — upload the .ma,
#    download an .fbx or .glb. Quality varies; verify the rig/scale after.
#
# Once you have player.fbx (or player.glb), drop it in assets/player/ and the
# game (game.js -> loadPlayerModel) auto-detects and uses it as the player.
# ---------------------------------------------------------------------------
