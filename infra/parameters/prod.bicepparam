using '../main.bicep'

param environment = 'prod'
param location = 'westeurope'
param acrName = 'autopodprodacr'
param daemonImageTag = 'latest' // Overridden in CI with commit SHA
