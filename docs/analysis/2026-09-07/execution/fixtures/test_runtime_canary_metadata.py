import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('discovery', Path(__file__).with_name('inspect-runtime-and-canary-metadata.py'))
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class MetadataFilters(unittest.TestCase):
    def test_only_selected_environment_fields_leave_memory(self):
        raw = b'AZURE_SANDBOX_GROUP=autopod-spike\0SECRET_TOKEN=private-value\0ACR_PASSWORD=private-value\0ACR_REGISTRY_URL=https://example.azurecr.io\0'
        result = discovery.selected_environment(raw)
        self.assertEqual(result, {'AZURE_SANDBOX_GROUP': 'autopod-spike', 'ACR_REGISTRY_HOST': 'example.azurecr.io'})
        self.assertNotIn('private-value', json.dumps(result))

    def test_registry_credentials_and_query_values_are_not_exported(self):
        for value in ['https://user:private@example.azurecr.io', 'https://example.azurecr.io?key=private', 'https://example.azurecr.io/private']:
            result = discovery.selected_environment(('ACR_REGISTRY_URL=' + value).encode())
            self.assertIsNone(result['ACR_REGISTRY_HOST'])
            self.assertNotIn('private', json.dumps(result))

    def test_image_reference_and_label_limits(self):
        self.assertEqual(discovery.image_reference('example.azurecr.io/app:latest'), 'example.azurecr.io/app:latest')
        self.assertIsNotNone(discovery.image_reference('example.azurecr.io/app@sha256:' + 'a' * 64))
        for value in ['https://user:secret@example.azurecr.io/app', 'user@registry/app', 'a' * 257]:
            self.assertIsNone(discovery.image_reference(value))
        self.assertIsNone(discovery.label('name with private content'))
        self.assertIsNone(discovery.label('x' * 91))


if __name__ == '__main__':
    unittest.main(verbosity=2)
