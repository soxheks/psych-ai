from django.test import TestCase
from django.urls import reverse


class PageTests(TestCase):
    def test_landing_page_links_to_main_experiences(self):
        response = self.client.get(reverse('landing'))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, reverse('home'))
        self.assertContains(response, reverse('journal'))
        self.assertContains(response, '心研同伴')

    def test_chat_page_is_available_at_chat_path(self):
        response = self.client.get(reverse('home'))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, '心理沟通智能体')

    def test_journal_page_keeps_note_processing_in_browser(self):
        response = self.client.get(reverse('journal'))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, '仅在当前页面')
        self.assertContains(response, 'journalForm')
