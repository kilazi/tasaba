#!/bin/bash
set -e

PROJECT="careful-memory-476520-d2"
SERVICE="tasaba"
REGION="us-central1"

echo "Deploying TasaBA to Cloud Run..."
gcloud run deploy $SERVICE \
  --project $PROJECT \
  --region $REGION \
  --source . \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 60 \
  --set-env-vars "OPENAI_API_KEY=${OPENAI_API_KEY:-}" \
  --min-instances 0 \
  --max-instances 3 \
  --clear-base-image

echo "Deployed! URL: https://$SERVICE-473141067823.$REGION.run.app"
