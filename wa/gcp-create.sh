#!/bin/bash
# Run once in Google Cloud Shell (owner 25.11): a project, a budget that stops everything at the first cost,
# and the free-size machine (e2-micro, us-central1) that installs the WhatsApp link by itself.
set -e
BR=feat/nouvelle-page-accueil
BILL=$(gcloud billing accounts list --filter=open=true --format='value(name)' | head -1 | sed 's#billingAccounts/##')
[ -n "$BILL" ] || { echo "אין חשבון חיוב פעיל"; exit 1; }
P=$(gcloud projects list --filter='name:"LBV WhatsApp"' --format='value(projectId)' | head -1)
if [ -z "$P" ]; then P=lbv-wa-$(date +%s | tail -c 7); gcloud projects create "$P" --name="LBV WhatsApp" -q; fi
gcloud config set project "$P" -q
gcloud billing projects link "$P" --billing-account="$BILL" -q >/dev/null
gcloud services enable compute.googleapis.com pubsub.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com -q
gcloud pubsub topics describe budget >/dev/null 2>&1 || gcloud pubsub topics create budget -q
gcloud pubsub subscriptions describe budget-wa >/dev/null 2>&1 || gcloud pubsub subscriptions create budget-wa --topic budget -q
NUM=$(gcloud projects describe "$P" --format='value(projectNumber)')
SA="$NUM-compute@developer.gserviceaccount.com"
for i in 1 2 3 4 5 6; do gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 && break; sleep 10; done
gcloud pubsub subscriptions add-iam-policy-binding budget-wa --member="serviceAccount:$SA" --role=roles/pubsub.subscriber -q >/dev/null
CUR=$(gcloud billing accounts describe "$BILL" --format='value(currencyCode)')
if ! gcloud billing budgets list --billing-account="$BILL" --format='value(displayName)' | grep -q '^lbv-wa stop$'; then
  gcloud billing budgets create --billing-account="$BILL" --display-name="lbv-wa stop" --budget-amount="1$CUR" \
    --filter-projects="projects/$P" --threshold-rule=percent=0.01 --notifications-rule-pubsub-topic="projects/$P/topics/budget" -q
fi
gcloud compute instances describe lbv-wa --zone us-central1-a >/dev/null 2>&1 || gcloud compute instances create lbv-wa \
  --zone us-central1-a --machine-type e2-micro --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-standard --scopes cloud-platform \
  --metadata startup-script="curl -fsSL https://raw.githubusercontent.com/yichaiassous-boop/lbv-portal/$BR/wa/setup-google.sh | bash",budget-sub="projects/$P/subscriptions/budget-wa" -q
echo
echo "DONE project=$P"
