# Generated by Django 4.2.22 on 2025-07-29 15:37

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "0811_personalapikey_last_rolled_at"),
    ]

    operations = [
        migrations.AddField(
            model_name="sessionrecordingviewed",
            name="bulk_viewed",
            field=models.BooleanField(default=False),
        ),
    ]
