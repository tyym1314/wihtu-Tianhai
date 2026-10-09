"""Scope checks for the two production-player certificate systemd units.

The caller binds this helper and the supplied Runtime to an immutable release.
Runtime.loaded_commands must use the reviewed typed D-Bus sampler, including
its NeedDaemonReload, PartOf, BindsTo and DropInPaths checks. This module never
loads, starts, enables, stops or rewrites a service itself.
"""
import hashlib
import os
from pathlib import Path
import shlex
import stat

UNIT_NAMES = ('oasis-production-player-certificate.service',
              'oasis-production-player-certificate.timer')
UNIT_PREFIX = 'oasis-production-player-certificate'
MAIN_ROOT = Path('/etc/systemd/system')
SYSTEMD_ROOTS = ('/etc/systemd/system', '/run/systemd/system',
                 '/run/systemd/transient', '/run/systemd/system.control',
                 '/etc/systemd/system.control', '/usr/lib/systemd/system',
                 '/lib/systemd/system')
ROOT_UID = 0
COMMAND_PROPERTIES = ('ExecStartPre', 'ExecStart', 'ExecStartPost',
                      'ExecStop', 'ExecStopPost')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def normalized_templates(templates):
    require(isinstance(templates, dict) and set(templates) == set(UNIT_NAMES),
            'CERTIFICATE_UNIT_TEMPLATE_SCOPE_INVALID')
    result = {}
    for name, body in templates.items():
        if isinstance(body, str):
            body = body.encode('utf8')
        require(isinstance(body, bytes) and 0 < len(body) <= 262144
                and b'\0' not in body, 'CERTIFICATE_UNIT_TEMPLATE_INVALID')
        result[name] = body
    return result


def regular_bytes(path, *, owned=False):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_size <= 262144,
            'CERTIFICATE_UNIT_FILE_UNSAFE')
    if owned:
        require(before.st_uid == ROOT_UID and before.st_nlink == 1
                and stat.S_IMODE(before.st_mode) == 0o644,
                'CERTIFICATE_UNIT_FILE_UNSAFE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        current = os.fstat(fd)
        require((current.st_dev, current.st_ino) ==
                (before.st_dev, before.st_ino), 'CERTIFICATE_UNIT_FILE_CHANGED')
        data = bytearray()
        while len(data) <= 262144:
            block = os.read(fd, min(65536, 262145 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(fd)
        leaf = path.lstat()
        require((after.st_size, after.st_mtime_ns, after.st_ctime_ns,
                 leaf.st_dev, leaf.st_ino, leaf.st_mtime_ns, leaf.st_ctime_ns) ==
                (before.st_size, before.st_mtime_ns, before.st_ctime_ns,
                 before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns)
                and len(data) == before.st_size,
                'CERTIFICATE_UNIT_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


def references_unit(value):
    return UNIT_PREFIX in value


def safe_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == ROOT_UID
            and not stat.S_IMODE(info.st_mode) & 0o022,
            'CERTIFICATE_UNIT_DIRECTORY_UNSAFE')


def enabled_link_guard(path, templates):
    info = path.lstat()
    require(path.parent == MAIN_ROOT / 'timers.target.wants'
            and path.name == UNIT_NAMES[1] and path.name in templates
            and info.st_uid == ROOT_UID and info.st_nlink == 1
            and path.resolve(strict=True) == MAIN_ROOT / path.name,
            'CERTIFICATE_UNIT_LINK_UNSAFE')
    safe_directory(path.parent)


def expected_commands(template):
    if isinstance(template, bytes):
        template = template.decode('utf8')
    return {key: [[parts[0], parts, False] for parts in
                  [shlex.split(line.partition('=')[2])
                   for line in template.splitlines()
                   if line.startswith(key + '=')]]
            for key in COMMAND_PROPERTIES}


def namespace_guard(templates, runtime, installed=False):
    """Reject foreign disk definitions/dependencies and uninstalled cached units."""
    templates = normalized_templates(templates)
    safe_directory(MAIN_ROOT)
    wants = MAIN_ROOT / 'timers.target.wants'
    if wants.exists() or wants.is_symlink():
        safe_directory(wants)
    found = set()
    for root in SYSTEMD_ROOTS:
        for path in Path(root).rglob('*'):
            if path.is_symlink():
                if references_unit(path.name) or references_unit(os.readlink(path)):
                    enabled_link_guard(path, templates)
            elif path.is_file():
                if path.parent == MAIN_ROOT and path.name in templates:
                    require(regular_bytes(path, owned=True) == templates[path.name],
                            'CERTIFICATE_UNIT_CONTENT_CHANGED')
                    found.add(path.name)
                else:
                    require(not references_unit(path.name)
                            and not references_unit(regular_bytes(path).decode('utf8', errors='replace')),
                            'CERTIFICATE_UNIT_FOREIGN_DEPENDENCY')
            elif path.is_dir():
                require(not references_unit(path.name),
                        'CERTIFICATE_UNIT_FOREIGN_DIRECTORY')
            else:
                require(not references_unit(path.name),
                        'CERTIFICATE_UNIT_FOREIGN_SPECIAL_FILE')
    if installed:
        require(found == set(UNIT_NAMES), 'CERTIFICATE_UNIT_DEFINITION_MISSING')
    else:
        for name in UNIT_NAMES:
            value = runtime.service(name)
            require(not value.get('FragmentPath') and not value.get('DropInPaths')
                    and str(value.get('MainPID') or 0) == '0',
                    'CERTIFICATE_UNIT_ALREADY_LOADED')
    return {'units': {name: hashlib.sha256(body).hexdigest()
                      for name, body in templates.items()}, 'installed': bool(installed)}


def loaded_guard(templates, runtime):
    """Verify exact installed definitions and effective commands before enable."""
    templates = normalized_templates(templates)
    result = namespace_guard(templates, runtime, installed=True)
    for name in UNIT_NAMES:
        value = runtime.service(name)
        require(value.get('FragmentPath') == str(MAIN_ROOT / name)
                and not value.get('DropInPaths')
                and value.get('NeedDaemonReload') == 'no',
                'CERTIFICATE_UNIT_LOADED_FRAGMENT_CHANGED')
        expected = expected_commands(templates[name]) if name.endswith('.service') else {}
        require(runtime.loaded_commands(name) == expected,
                'CERTIFICATE_UNIT_LOADED_COMMAND_CHANGED')
    return result
