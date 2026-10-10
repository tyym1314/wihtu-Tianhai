"""Focused marker-approved old snapshots. No service or database actions."""
import copy
import unittest
from unittest.mock import patch
import test_admission_runtime as fixture

a, o, p = fixture.a, fixture.o, fixture.p


def successor():
    marker, old, _ = fixture.free_history()
    fixture.closed_configuration(marker, old)
    new = copy.deepcopy(old)
    new.pop('configuration_history')
    new['release'] = '/opt/oasis/releases/20261010-05'
    new['manifest_sha256'] = '5' * 64
    new['runtime_profile'].update(release=new['release'], manifest_sha256=new['manifest_sha256'])
    new['private_pins']['runtime.env'] = fixture.pin(b'synthetic new source runtime')
    new['policy_approvals'] = [copy.deepcopy(old['policy_approvals'][-1])]
    new['policy_approvals'][0].update(release=new['release'], manifest_sha256=new['manifest_sha256'], revision='3')
    marker.update(release=new['release'], manifest_sha256=new['manifest_sha256'], private_pins=copy.deepcopy(new['private_pins']))
    marker['release_history'].append(new)
    return marker, old, new


class HistoricalSnapshotTests(unittest.TestCase):
    def test_only_predecessor_marker_approvals_and_configurations_are_used(self):
        marker, old, new = successor()
        history = a.historical_sources(marker, new['release'], new['manifest_sha256'])
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]['policy_approvals'], old['policy_approvals'])
        self.assertEqual(a.inspection_expectation({**new, 'historical_sources': history})['historical_policy_approvals'], old['policy_approvals'])
        self.assertNotIn('historical_policy_approvals', a.inspection_expectation(old))
        self.assertEqual(a.historical_sources(marker, old['release'], old['manifest_sha256']), [])

    def test_drifted_historical_source_and_unapproved_configuration_refused(self):
        for change in (lambda m,o,n: o['policy_approvals'][0].update(release=n['release']),
                       lambda m,o,n: o['private_pins']['postgres.env'].update(sha256='9'*64),
                       lambda m,o,n: o['configuration_history'][0]['runtime_profile'].update(app_id='foreign')):
            marker, old, new = successor(); change(marker, old, new)
            with self.assertRaises(ValueError): a.historical_sources(marker, new['release'], new['manifest_sha256'])

    def test_scope_revision_conflict_and_future_revision_refused(self):
        for change in (lambda o: o['policy_approvals'][0].update(revision='3'),
                       lambda o: o['policy_approvals'][0].update(revision='4'),
                       lambda o: o['policy_approvals'][0]['scope'].update(wallet_scope_id='foreign'),
                       lambda o: o['policy_approvals'][0].update(currency_scale=2)):
            marker, old, new = successor(); change(old)
            with self.assertRaises(ValueError): a.historical_sources(marker, new['release'], new['manifest_sha256'])

    def test_operations_independently_verifies_historical_helpers(self):
        marker, old, new = successor(); calls=[]
        def verify(release, manifest, helpers):
            calls.append((str(release), manifest, helpers))
            return {'helpers': helpers, 'inspection_closure': {'actual-synthetic-import': '8'*64}}
        with patch.object(o.p, 'verify_historical_release', side_effect=verify):
            source=o.backup_source(marker,new['release'],new['manifest_sha256'])
        self.assertEqual([call[0] for call in calls], [new['release'],old['release']])
        self.assertEqual(source['historical_sources'][0]['helpers'],old['helpers'])
        def corrupt(release, manifest, helpers):
            return {'helpers': {} if str(release)==old['release'] else helpers,
                    'inspection_closure': {'actual-synthetic-import':'8'*64}}
        with patch.object(o.p,'verify_historical_release',side_effect=corrupt):
            with self.assertRaises(o.p.Refusal): o.backup_source(marker,new['release'],new['manifest_sha256'])


if __name__ == '__main__': unittest.main()
