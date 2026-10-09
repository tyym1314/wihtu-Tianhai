"""Pure public admission/configuration contracts. Never reads files or approves a policy."""
import datetime as dt
import json
import re
from urllib.parse import urlsplit, unquote

FREE_PROFILE = 'firstparty-free-v1'
FREE_FIELDS = ('OASIS_ADMISSION_PROFILE', 'OASIS_FIRSTPARTY_APP_ID',
               'OASIS_ADMISSION_RELEASE', 'OASIS_ADMISSION_MANIFEST_SHA256')
PRIVATE_NAMES = {'runtime.env', 'postgres.env', 'operator-credentials.json', 'state/master.key'}
LEGACY_HELPERS = {'provision.py', 'bootstrap.mjs', 'operations.py', 'inspect-backup.mjs', 'monitor.mjs'}
CURRENT_HELPERS = LEGACY_HELPERS | {'admission-runtime.py'}
ARENA_GAMES = {'run','towerlink','golf','bowling','carrom','pool','darts','match','ludo','jackaroo','domino'}
SCOPE_FIELDS = ('partner_id', 'app_id', 'environment', 'wallet_scope_id', 'currency_id')
POLICY_FIELDS = ('app_id', 'profile', 'state', 'revision', 'scope', 'currency_scale',
                 'allowed_origins', 'game_ids', 'release', 'manifest_sha256',
                 'proof_sha256', 'approved_by', 'approved_at')

def require(value, code):
    if not value:
        raise ValueError(code)

def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value) is not None

def sha(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None

def release_path(value):
    return isinstance(value, str) and re.fullmatch(r'/opt/oasis/releases/\d{8}-\d{2}', value) is not None

def public_origin(value):
    try:
        url = urlsplit(value)
        return (isinstance(value, str) and url.scheme == 'https' and bool(url.hostname)
                and not url.username and not url.password and not url.path and not url.query
                and not url.fragment and value == 'https://' + url.netloc)
    except (ValueError, TypeError):
        return False

def parse_env_text(text):
    require(isinstance(text, str) and len(text.encode()) <= 16384, 'PRODUCTION_ARCHIVE_ENV_INVALID')
    result = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        require(separator and re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and key not in result
                and '\x00' not in value and '\r' not in value, 'PRODUCTION_ARCHIVE_ENV_INVALID')
        result[key] = value
    return result

def runtime_profile(env, *, expected_release=None, expected_manifest=None):
    require(env.get('OASIS_PRODUCTION_ADMISSION_ENABLED') in (None, '0'),
            'GENERIC_PRODUCTION_ADMISSION_FORBIDDEN')
    profile = env.get('OASIS_ADMISSION_PROFILE') or 'closed'
    require(profile in ('closed', FREE_PROFILE), 'INVALID_ADMISSION_PROFILE')
    origin = env.get('OASIS_PUBLIC_ORIGIN')
    require(public_origin(origin), 'PRODUCTION_HTTPS_ORIGIN_REQUIRED')
    if profile == 'closed':
        require(all(name not in env for name in FREE_FIELDS[1:]), 'CLOSED_ADMISSION_CONFIG_AMBIGUOUS')
        return {'profile': profile, 'public_origin': origin, 'app_id': None,
                'release': None, 'manifest_sha256': None}
    app = env.get(FREE_FIELDS[1]); source = env.get(FREE_FIELDS[2]); manifest = env.get(FREE_FIELDS[3])
    require(identifier(app) and app.startswith('app_') and release_path(source) and sha(manifest),
            'FIRSTPARTY_ADMISSION_CONFIG_REQUIRED')
    require((expected_release is None or source == expected_release)
            and (expected_manifest is None or manifest == expected_manifest),
            'FIRSTPARTY_ADMISSION_SOURCE_CHANGED')
    return {'profile': profile, 'public_origin': origin, 'app_id': app,
            'release': source, 'manifest_sha256': manifest}

def archive_runtime(env, current_env, profile):
    require(env.get('OASIS_ENVIRONMENT') == 'production' and env.get('NODE_ENV') == 'production'
            and env.get('OASIS_START_WALLET') == '0' and env.get('OASIS_API_PORT') == '18891'
            and env.get('OASIS_LOCAL_DIR') == '/opt/oasis/production-instance-private/state/',
            'PRODUCTION_ARCHIVE_RUNTIME_SCOPE_INVALID')
    try:
        db = urlsplit(env.get('OASIS_DATABASE_URL', ''))
        valid = (db.scheme == 'postgres' and db.hostname == '127.0.0.1' and db.port == 18893
                 and db.path == '/oasis_production' and unquote(db.username or '') == 'oasis_prod_app'
                 and bool(db.password) and not db.query and not db.fragment)
    except ValueError:
        valid = False
    require(valid, 'PRODUCTION_ARCHIVE_DATABASE_SCOPE_INVALID')
    require({k: v for k, v in env.items() if k not in FREE_FIELDS}
            == {k: v for k, v in current_env.items() if k not in FREE_FIELDS},
            'PRODUCTION_ARCHIVE_NON_ADMISSION_CONFIG_CHANGED')
    require(runtime_profile(env) == profile, 'PRODUCTION_ARCHIVE_PROFILE_CHANGED')

def normalize_policy(value):
    require(isinstance(value, dict) and set(value) == set(POLICY_FIELDS), 'PRODUCTION_POLICY_SNAPSHOT_INVALID')
    result = dict(value)
    require(identifier(value['app_id']) and value['profile'] == FREE_PROFILE
            and value['state'] in ('closed', 'open'), 'PRODUCTION_POLICY_SNAPSHOT_INVALID')
    revision = str(value['revision'])
    require(re.fullmatch(r'[1-9][0-9]{0,18}', revision) and int(revision) <= 9223372036854775807,
            'PRODUCTION_POLICY_REVISION_INVALID')
    result['revision'] = revision
    scope = value['scope']
    require(isinstance(scope, dict) and set(scope) == set(SCOPE_FIELDS)
            and all(identifier(scope[name]) for name in SCOPE_FIELDS)
            and scope['partner_id'] == 'partner_oasis_platform' and scope['environment'] == 'production'
            and scope['app_id'] == value['app_id'], 'PRODUCTION_POLICY_SCOPE_INVALID')
    require(type(value['currency_scale']) is int and 0 <= value['currency_scale'] <= 6,
            'PRODUCTION_POLICY_SCOPE_INVALID')
    origins = value['allowed_origins']; games = value['game_ids']
    require(isinstance(origins, list) and origins and len(set(origins)) == len(origins)
            and all(public_origin(item) for item in origins), 'PRODUCTION_POLICY_ORIGINS_INVALID')
    require(isinstance(games, list) and games and len(set(games)) == len(games)
            and all(identifier(item) for item in games) and set(games)==ARENA_GAMES,
            'PRODUCTION_POLICY_GAMES_INVALID')
    result['allowed_origins'] = sorted(origins); result['game_ids'] = sorted(games)
    require(release_path(value['release']) and sha(value['manifest_sha256']) and sha(value['proof_sha256'])
            and identifier(value['approved_by']), 'PRODUCTION_POLICY_SOURCE_INVALID')
    try:
        at = dt.datetime.fromisoformat(value['approved_at'].replace('Z', '+00:00'))
        require(at.tzinfo is not None, 'PRODUCTION_POLICY_APPROVAL_TIME_INVALID')
        result['approved_at'] = at.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except (ValueError, TypeError, AttributeError):
        raise ValueError('PRODUCTION_POLICY_APPROVAL_TIME_INVALID') from None
    return result

def validated_configuration(value, marker, release, manifest, contract):
    require(isinstance(value,dict) and set(value)=={'private_pins','runtime_profile','policy_approvals'},
            'PRODUCTION_CONFIGURATION_HISTORY_INVALID')
    private=value['private_pins'];profile=value['runtime_profile']
    require(isinstance(private, dict) and set(private) == PRIVATE_NAMES,
            'PRODUCTION_HISTORY_PRIVATE_PINS_REQUIRED')
    for name, pin in private.items():
        require(isinstance(pin, dict) and set(pin)=={'uid','gid','mode','device','inode','kind','bytes','sha256'}
                and pin['kind']=='file' and all(type(pin.get(field)) is int and pin[field]>=0 for field in ('uid','gid','device','inode','bytes'))
                and sha(pin.get('sha256')) and pin['bytes'] > 0 and pin.get('mode') == 0o600,
                'PRODUCTION_HISTORY_PRIVATE_PIN_INVALID')
        if name != 'runtime.env':
            require(pin == marker.get('private_pins', {}).get(name), 'PRODUCTION_HISTORY_SECRET_CHANGED')
    require(isinstance(profile, dict) and set(profile) == {'profile', 'public_origin', 'app_id', 'release', 'manifest_sha256'}
            and public_origin(profile['public_origin']), 'PRODUCTION_HISTORY_PROFILE_INVALID')
    approvals = value['policy_approvals']
    require(isinstance(approvals, list) and len(approvals) <= 256, 'PRODUCTION_POLICY_APPROVAL_HISTORY_REQUIRED')
    normalized = [normalize_policy(policy) for policy in approvals]
    require(len({json.dumps(policy, sort_keys=True) for policy in normalized}) == len(normalized),
            'PRODUCTION_POLICY_APPROVAL_HISTORY_AMBIGUOUS')
    if profile['profile'] == 'closed':
        require(profile['app_id'] is None and profile['release'] is None and profile['manifest_sha256'] is None
                and not normalized, 'PRODUCTION_HISTORY_PROFILE_INVALID')
    else:
        require(profile['profile'] == FREE_PROFILE and contract=='production-free-v2' and identifier(profile['app_id'])
                and profile['release'] == release and profile['manifest_sha256'] == manifest and normalized,
                'PRODUCTION_HISTORY_PROFILE_INVALID')
        require(all(policy['app_id'] == profile['app_id'] and policy['release'] == release
                    and policy['manifest_sha256'] == manifest and profile['public_origin'] in policy['allowed_origins']
                    for policy in normalized), 'PRODUCTION_POLICY_HISTORY_SOURCE_CHANGED')
    return {**value, 'policy_approvals': normalized}

def approved_source(marker, release, manifest, *, runtime_env_sha=None, runtime_profile_selector=None):
    """Receipt values select an independently approved configuration, never approve one."""
    require(release_path(release) and sha(manifest), 'PRODUCTION_BACKUP_SOURCE_INVALID')
    history = marker.get('release_history')
    require(isinstance(history, list) and 0 < len(history) <= 128, 'PRODUCTION_RELEASE_HISTORY_REQUIRED')
    matches = [entry for entry in history if isinstance(entry, dict)
               and entry.get('release') == release and entry.get('manifest_sha256') == manifest]
    require(len(matches) == 1, 'PRODUCTION_BACKUP_SOURCE_NOT_APPROVED')
    entry=matches[0];helpers=entry.get('helpers');contract=entry.get('inspection_contract')
    require(isinstance(helpers, dict) and set(helpers) in (LEGACY_HELPERS, CURRENT_HELPERS)
            and all(sha(digest) for digest in helpers.values()), 'PRODUCTION_HISTORY_HELPERS_INVALID')
    require((contract=='production-closed-v1' and set(helpers)==LEGACY_HELPERS)
            or (contract=='production-free-v2' and set(helpers)==CURRENT_HELPERS), 'PRODUCTION_HISTORY_CONTRACT_INVALID')
    past=entry.get('configuration_history',[])
    require(isinstance(past,list) and len(past)<=128,'PRODUCTION_CONFIGURATION_HISTORY_INVALID')
    current={name:entry.get(name) for name in ('private_pins','runtime_profile','policy_approvals')}
    configurations=[validated_configuration(value,marker,release,manifest,contract) for value in [current,*past]]
    identities=[(value['private_pins']['runtime.env']['sha256'],json.dumps(value['runtime_profile'],sort_keys=True)) for value in configurations]
    require(len(set(identities))==len(identities),'PRODUCTION_CONFIGURATION_HISTORY_AMBIGUOUS')
    if runtime_env_sha is None and runtime_profile_selector is None:selected=configurations[0]
    else:
        require(sha(runtime_env_sha) and isinstance(runtime_profile_selector,dict),'PRODUCTION_BACKUP_CONFIGURATION_SELECTOR_REQUIRED')
        selected=[value for value in configurations if value['private_pins']['runtime.env']['sha256']==runtime_env_sha
                  and value['runtime_profile']==runtime_profile_selector]
        require(len(selected)==1,'PRODUCTION_BACKUP_CONFIGURATION_NOT_APPROVED');selected=selected[0]
    return {**entry,**selected}

def inspection_expectation(source):
    return {name: source[name] for name in ('inspection_contract', 'runtime_profile', 'policy_approvals')}
