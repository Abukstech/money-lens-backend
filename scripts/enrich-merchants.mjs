
import {
    readFileSync,
    writeFileSync,
    mkdirSync,
  } from 'node:fs';
  import { resolve, join } from 'node:path';
  
  const file = resolve(
    'src/merchants/data/nigeria-merchants.json',
  );
  
  // Common goods and services associated with each business.
  // These are possible purchases, not confirmed receipt items.
  const profiles = {
    shoprite: [
      ['groceries', ['foodstuff', 'beverages', 'fresh produce']],
      ['shopping', ['household supplies', 'cleaning products']],
      ['personal_care', ['toiletries', 'personal care products']],
    ],
    spar: [
      ['groceries', ['foodstuff', 'beverages', 'fresh produce']],
      ['shopping', ['household goods', 'cleaning products']],
      ['personal_care', ['toiletries']],
    ],
    'market square': [
      ['groceries', ['foodstuff', 'beverages']],
      ['shopping', ['household products']],
    ],
    'chicken republic': [
      ['dining', ['prepared chicken meals', 'rice meals', 'fast food']],
    ],
    'dominos pizza': [
      ['dining', ['pizza', 'prepared meals']],
    ],
    kilimanjaro: [
      ['dining', ['restaurant meals', 'prepared food']],
    ],
    bolt: [
      ['transport', ['ride-hailing trips', 'passenger transport']],
    ],
    uber: [
      ['transport', ['ride-hailing trips', 'passenger transport']],
    ],
    mtn: [
      ['telecommunications', ['mobile data', 'airtime', 'voice services']],
    ],
    airtel: [
      ['telecommunications', ['mobile data', 'airtime', 'voice services']],
    ],
    glo: [
      ['telecommunications', ['mobile data', 'airtime', 'voice services']],
    ],
    ikedc: [
      ['utilities', ['electricity bills', 'prepaid electricity tokens']],
    ],
    ekedc: [
      ['utilities', ['electricity bills', 'prepaid electricity tokens']],
    ],
    jumia: [
      ['shopping', ['electronics', 'household goods', 'marketplace products']],
    ],
    netflix: [
      ['subscriptions', ['video streaming services']],
    ],
    udemy: [
      ['education', ['online courses', 'digital learning']],
    ],
    bet9ja: [
      ['gambling', ['sports betting']],
    ],
    totalenergies: [
      ['transport', ['petrol', 'diesel', 'vehicle fuel']],
    ],
  };
  
  function normalize(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  
  const original = readFileSync(file, 'utf8');
  const dataset = JSON.parse(original);
  
  if (
    dataset.schema_version !== '1.0.0' ||
    !Array.isArray(dataset.vendors)
  ) {
    throw new Error('Unexpected merchant dataset format');
  }
  
  let addedOfferings = 0;
  let matchedMerchants = 0;
  
  for (const vendor of dataset.vendors) {
    // Processors are not proof of an underlying purchase.
    const isIntermediary =
      vendor.is_intermediary ||
      ['bank', 'payment_processor', 'financial_platform']
        .includes(vendor.entity_type);
  
    const existing = Array.isArray(vendor.typical_purchases)
      ? vendor.typical_purchases
      : [];
  
    const key = normalize(vendor.name);
    const idKey = normalize(vendor.id);
  
    const offerings = isIntermediary
      ? []
      : profiles[key] ?? profiles[idKey] ?? [];
  
    if (offerings.length > 0) {
      matchedMerchants++;
    }
  
    for (const [category, examples] of offerings) {
      if (existing.some(item => item.category === category)) {
        continue;
      }
  
      existing.push({
        category,
        examples,
        evidence: 'business_type_inference',
        source_urls: [],
      });
  
      addedOfferings++;
    }
  
    vendor.typical_purchases = existing;
  
    // Keep previously researched locations.
    // Do not invent branches or store addresses.
    vendor.known_locations =
      Array.isArray(vendor.known_locations)
        ? vendor.known_locations
        : [];
  }
  
  console.log({
    totalMerchants: dataset.vendors.length,
    matchedMerchants,
    newOfferings: addedOfferings,
  });
  
  if (process.argv.includes('--apply')) {
    mkdirSync(resolve('reports'), { recursive: true });
  
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-');
  
    const backup = join(
      'reports',
      `nigeria-merchants-backup-${stamp}.json`,
    );
  
    writeFileSync(backup, original);
  
    writeFileSync(
      file,
      JSON.stringify(dataset, null, 2) + '\n',
    );
  
    console.log('Merchant dataset updated.');
    console.log('Backup:', backup);
  } else {
    console.log('Preview only. No files changed.');
  }
  