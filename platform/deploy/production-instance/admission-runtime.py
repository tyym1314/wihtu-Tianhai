"""Pure public admission/configuration contracts. Never reads files or approves a policy."""
import datetime as dt
import json
import re
from urllib.parse import urlsplit, unquote

FREE_PROFILE = 'firstparty-free-v1'
INTERNAL_PROFILE = 'firstparty-internal-games-v1'
INTERNAL_CONTRACT = 'production-internal-games-v1'
INTERNAL_COIN_SCOPE = 'internal-nonredeemable'
INITIAL_PLAYER_COINS = '10000'
INITIAL_TREASURY_COINS = '1000000000'
FREE_FIELDS = ('OASIS_ADMISSION_PROFILE', 'OASIS_FIRSTPARTY_APP_ID',
               'OASIS_ADMISSION_RELEASE', 'OASIS_ADMISSION_MANIFEST_SHA256')
PRIVATE_NAMES = {'runtime.env', 'postgres.env', 'operator-credentials.json', 'state/master.key'}
LEGACY_HELPERS = {'provision.py', 'bootstrap.mjs', 'operations.py', 'inspect-backup.mjs', 'monitor.mjs'}
CURRENT_HELPERS = LEGACY_HELPERS | {'admission-runtime.py'}
ARENA_GAMES = {'run','towerlink','golf','bowling','carrom','pool','darts','match','ludo','jackaroo','domino'}
RELEASED_GAMES = ARENA_GAMES | {'thunder','tiger'}
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
    require(profile in ('closed', FREE_PROFILE, INTERNAL_PROFILE), 'INVALID_ADMISSION_PROFILE')
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
    require(identifier(value['app_id']) and value['profile'] in (FREE_PROFILE, INTERNAL_PROFILE)
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
            and all(identifier(item) for item in games) and set(games)==(RELEASED_GAMES if value['profile']==INTERNAL_PROFILE else ARENA_GAMES),
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
        require(((profile['profile']==FREE_PROFILE and contract=='production-free-v2') or (profile['profile']==INTERNAL_PROFILE and contract==INTERNAL_CONTRACT)) and identifier(profile['app_id'])
                and profile['release'] == release and profile['manifest_sha256'] == manifest and normalized,
                'PRODUCTION_HISTORY_PROFILE_INVALID')
        require(all(policy['profile'] == profile['profile'] and policy['app_id'] == profile['app_id'] and policy['release'] == release
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
            or (contract in ('production-free-v2',INTERNAL_CONTRACT) and set(helpers)==CURRENT_HELPERS), 'PRODUCTION_HISTORY_CONTRACT_INVALID')
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

def historical_sources(marker, release, manifest):
    """Prior marker-approved sources authorize old snapshots, never current admission."""
    current = approved_source(marker, release, manifest)
    history = marker['release_history']
    position = next(index for index, entry in enumerate(history)
                    if entry['release'] == release and entry['manifest_sha256'] == manifest)
    if current['runtime_profile']['profile'] not in (FREE_PROFILE,INTERNAL_PROFILE):
        return []
    current_policies = current['policy_approvals']
    earliest = min(int(policy['revision']) for policy in current_policies)
    stable = ('app_id', 'profile', 'scope', 'currency_scale', 'allowed_origins', 'game_ids')
    reference = current_policies[0]
    seen = {policy['revision'] for policy in current_policies}
    require(len(seen) == len(current_policies), 'PRODUCTION_POLICY_REVISION_AMBIGUOUS')
    result = []
    for entry in history[:position]:
        source = approved_source(marker, entry['release'], entry['manifest_sha256'])
        configurations = [source, *entry.get('configuration_history', [])]
        policies = []
        unique = set()
        for configuration in configurations:
            # Re-select each approved archived configuration, including its pins.
            selected = approved_source(marker, source['release'], source['manifest_sha256'],
                runtime_env_sha=configuration['private_pins']['runtime.env']['sha256'],
                runtime_profile_selector=configuration['runtime_profile'])
            for policy in selected['policy_approvals']:
                identity = json.dumps(policy, sort_keys=True)
                if identity in unique:
                    continue
                unique.add(identity)
                compatible = all(policy[field]==reference[field] for field in stable) or (reference['profile']==INTERNAL_PROFILE and policy['profile']==FREE_PROFILE and set(policy['game_ids'])==ARENA_GAMES and set(reference['game_ids'])==RELEASED_GAMES and all(policy[field]==reference[field] for field in ('app_id','scope','currency_scale','allowed_origins')))
                require(compatible and int(policy['revision']) < earliest and policy['revision'] not in seen,
                        'PRODUCTION_HISTORICAL_POLICY_SCOPE_OR_REVISION_CHANGED')
                seen.add(policy['revision']); policies.append(policy)
        if policies:
            result.append({name: source[name] for name in ('release', 'manifest_sha256', 'helpers')}
                          | {'policy_approvals': policies})
    return result


def inspection_expectation(source):
    result = {name: source[name] for name in ('inspection_contract', 'runtime_profile', 'policy_approvals')}
    historical = source.get('historical_sources', [])
    if historical:
        result['historical_policy_approvals'] = [policy for item in historical for policy in item['policy_approvals']]
    return result


# New internal profile only. Old FREE11 audits are never reinterpreted.
INTERNAL_AUDIT_SQL = "WITH expected_math(game,version,hash,max_multiplier) AS (VALUES ('thunder','thunder-platform-98-v1','f8f24c5c9edcf286a8199d28186801b31c023e9f16d3a866c9713ef07c4b0e1c',10000),('thunder','thunder-platform-99-v1','44f59d68eb8aa0d121a47f19ac66223b271fa8ab641154b001e74aa664988d32',10000),('tiger','tiger-platform-98-v1','bbd94270e080b1a332f1da9617f7c5eec2d8f88b555615e5fe93523b443b4edc',455),('tiger','tiger-platform-99-v1','ff0a30882d50ddb1913c9e4b2b898bdcd4ad7f8c3c8ea43e7f20b4786b58e04d',455)),\nissues AS (SELECT o.*,o.operation->'receipt'->'resource' resource,w.currency_scale,w.internal_coin_issued,w.partner_id,w.app_id,w.environment,w.wallet_scope_id,w.currency_id FROM wallet_operations o JOIN wallet_scopes w USING(scope_id) WHERE o.kind='issue_internal_coins'),\nissue_errors AS (\n SELECT 1 FROM issues i WHERE i.state IS DISTINCT FROM 'SUCCEEDED' OR i.method IS DISTINCT FROM 'POST' OR i.path IS DISTINCT FROM '/internal/game-coins/issue' OR i.operation->'receipt'->>'resource_type' IS DISTINCT FROM 'internal_coin_issuance'\n OR i.resource->>'profile' IS DISTINCT FROM 'firstparty-internal-games-v1' OR i.resource->>'coin_scope' IS DISTINCT FROM 'internal-nonredeemable' OR i.resource->'redeemable' IS DISTINCT FROM 'false'::jsonb\n OR i.resource->>'partner_id' IS DISTINCT FROM i.partner_id OR i.resource->>'app_id' IS DISTINCT FROM i.app_id OR i.resource->>'environment' IS DISTINCT FROM i.environment OR i.resource->>'wallet_scope_id' IS DISTINCT FROM i.wallet_scope_id OR i.resource->>'currency_id' IS DISTINCT FROM i.currency_id\n OR NOT COALESCE(((i.resource->>'account'='treasury' AND (i.resource->>'amount_minor')::numeric=1000000000*power(10::numeric,i.currency_scale)) OR (i.resource->>'account' LIKE 'user:%' AND (i.resource->>'amount_minor')::numeric=10000*power(10::numeric,i.currency_scale) AND EXISTS(SELECT 1 FROM wallet_users u WHERE u.scope_id=i.scope_id AND 'user:'||u.external_user_id=i.resource->>'account'))),FALSE)\n OR NOT EXISTS(SELECT 1 FROM wallet_operation_ids r WHERE r.scope_id=i.scope_id AND r.operation_id=i.operation_id AND r.partner_id=i.partner_id AND r.app_id=i.app_id AND r.environment=i.environment)\n OR (SELECT count(*) FROM wallet_ledger l WHERE l.scope_id=i.scope_id AND l.operation_id=i.operation_id) IS DISTINCT FROM 2\n OR NOT EXISTS(SELECT 1 FROM wallet_ledger l WHERE l.scope_id=i.scope_id AND l.operation_id=i.operation_id AND l.account=i.resource->>'account' AND l.delta_available=(i.resource->>'amount_minor')::bigint AND l.delta_reserved=0 AND l.meta->>'kind'='internal_coin_issuance')\n OR NOT EXISTS(SELECT 1 FROM wallet_ledger l WHERE l.scope_id=i.scope_id AND l.operation_id=i.operation_id AND l.account='internal_coin_issuance' AND l.delta_available=-(i.resource->>'amount_minor')::bigint AND l.delta_reserved=0)\n UNION ALL SELECT 1 FROM issues GROUP BY scope_id,resource->>'account' HAVING count(*) IS DISTINCT FROM 1\n UNION ALL SELECT 1 FROM wallet_scopes w WHERE w.internal_coin_issued IS DISTINCT FROM (SELECT coalesce(sum((i.resource->>'amount_minor')::numeric),0) FROM issues i WHERE i.scope_id=w.scope_id)\n UNION ALL SELECT 1 FROM wallet_ledger l WHERE l.meta->>'kind'='internal_coin_issuance' AND NOT EXISTS(SELECT 1 FROM issues i WHERE i.scope_id=l.scope_id AND i.operation_id=l.operation_id)\n), math_errors AS (\n SELECT 1 FROM wallet_math_profiles m WHERE NOT EXISTS(SELECT 1 FROM expected_math e WHERE e.game=m.game_id AND e.version=m.math_version AND e.hash=m.math_config_hash AND e.max_multiplier=m.max_payout_multiplier)\n UNION ALL SELECT 1 FROM wallet_scopes w WHERE w.internal_coin_issued>0 AND (SELECT count(*) FROM wallet_math_profiles m WHERE m.scope_id=w.scope_id) IS DISTINCT FROM 4\n), cycle_errors AS (\n SELECT 1 FROM gp_cycles c LEFT JOIN gp_sessions s ON s.id=c.session_id LEFT JOIN gp_apps a ON a.id=c.app_id WHERE s.id IS NULL OR a.id IS NULL OR c.app_id IS DISTINCT FROM s.app_id OR c.external_user_id IS DISTINCT FROM s.external_user_id OR c.game_id IS DISTINCT FROM s.game_id OR s.admission_profile IS DISTINCT FROM 'firstparty-internal-games-v1' OR c.game_id NOT IN ('thunder','tiger') OR c.stake_minor NOT IN (1000,5000,10000,20000,50000)\n OR NOT EXISTS(SELECT 1 FROM expected_math e WHERE e.game=c.game_id AND e.version=c.math_version AND e.hash=c.math_hash AND c.max_payout_minor=c.stake_minor*e.max_multiplier)\n OR c.status NOT IN ('AUTHORIZING','AUTHORIZED','ACCEPTED','RESULT_FIXED','SETTLED','REJECTED')\n OR (c.status='SETTLED' AND (c.result IS NULL OR c.result_hash IS NULL OR c.seed_enc IS NULL OR c.payout_minor IS NULL OR c.payout_minor<0 OR c.payout_minor>c.max_payout_minor))\n), play_errors AS (\n SELECT 1 FROM gp_plays p LEFT JOIN gp_cycles c ON c.id=p.cycle_id LEFT JOIN gp_sessions s ON s.id=p.session_id LEFT JOIN gp_apps a ON a.id=s.app_id WHERE c.id IS NULL OR s.id IS NULL OR p.session_id IS DISTINCT FROM c.session_id OR c.status IS DISTINCT FROM 'SETTLED' OR p.bet*power(10::numeric,a.currency_scale) IS DISTINCT FROM c.stake_minor OR p.payload->>'cycleId' IS DISTINCT FROM c.id OR p.payload->>'settlementStatus' IS DISTINCT FROM 'SETTLED'\n), operation_errors AS (\n SELECT 1 FROM gp_operations o LEFT JOIN gp_cycles c ON c.id=o.aggregate_id WHERE c.id IS NULL OR c.app_id IS DISTINCT FROM o.app_id OR o.path NOT IN ('/wallet/v1/probability/authorize','/wallet/v1/probability/accept','/wallet/v1/probability/settle','/wallet/v1/probability/cancel')\n UNION ALL SELECT 1 FROM wallet_operations o WHERE o.kind IS DISTINCT FROM 'issue_internal_coins' AND o.path NOT IN ('/wallet/v1/probability/authorize','/wallet/v1/probability/accept','/wallet/v1/probability/settle','/wallet/v1/probability/cancel')\n), forbidden AS (\n SELECT (SELECT count(*) FROM wallet_matches)+(SELECT count(*) FROM wallet_reservations)+(SELECT count(*) FROM wallet_keys)+(SELECT count(*) FROM wallet_nonces)+(SELECT count(*) FROM wallet_events)+(SELECT count(*) FROM pvp_operations)+(SELECT count(*) FROM gp_transfer_bindings)+(SELECT count(*) FROM gp_transfer_accounts)+(SELECT count(*) FROM gp_transfers)+(SELECT count(*) FROM gp_transfer_outbox)+(SELECT count(*) FROM wallet_transfer_clearing) count\n)\nSELECT json_build_object('internal_coin_integrity_errors',(SELECT count(*) FROM issue_errors)+(SELECT count(*) FROM math_errors),'internal_financial_scope_errors',(SELECT count(*) FROM cycle_errors)+(SELECT count(*) FROM play_errors)+(SELECT count(*) FROM operation_errors)+(SELECT count FROM forbidden));"

def internal_audit_sql():
    return INTERNAL_AUDIT_SQL
