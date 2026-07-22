import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapLineItemToDetailedItem,
  resolveExactVariantImage,
} from '../src/shopifyOAuth.js';

const product = {
  id: 100,
  title: 'Classic Shoe',
  image: { id: 10, src: 'https://cdn.example/featured-beige.jpg' },
  options: [
    { name: 'Color', position: 1 },
    { name: 'Size', position: 2 },
  ],
  images: [
    { id: 10, src: 'https://cdn.example/beige.jpg', variant_ids: [1001] },
    { id: 20, src: 'https://cdn.example/black.jpg', variant_ids: [1002] },
  ],
  variants: [
    {
      id: 1001,
      title: 'Beige / 38',
      option1: 'Beige',
      option2: '38',
      image_id: 10,
      sku: 'BEIGE-38',
    },
    {
      id: 1002,
      title: 'Black / 39',
      option1: 'Black',
      option2: '39',
      image_id: 20,
      sku: 'BLACK-39',
    },
  ],
};

test('maps each line item to its own variant image and labeled options', () => {
  const black = mapLineItemToDetailedItem(
    {
      id: 501,
      product_id: 100,
      variant_id: 1002,
      title: 'Classic Shoe',
      quantity: 2,
    },
    product
  );
  const beige = mapLineItemToDetailedItem(
    {
      id: 502,
      product_id: 100,
      variant_id: 1001,
      title: 'Classic Shoe',
      quantity: 1,
    },
    product
  );

  assert.deepEqual(
    {
      lineItemId: black.lineItemId,
      variantId: black.variantId,
      quantity: black.quantity,
      color: black.color,
      size: black.size,
      sku: black.sku,
      imageUrl: black.imageUrl,
    },
    {
      lineItemId: '501',
      variantId: '1002',
      quantity: 2,
      color: 'Black',
      size: '39',
      sku: 'BLACK-39',
      imageUrl: 'https://cdn.example/black.jpg',
    }
  );
  assert.equal(beige.color, 'Beige');
  assert.equal(beige.imageUrl, 'https://cdn.example/beige.jpg');
  assert.notEqual(black.imageUrl, beige.imageUrl);
});

test('never guesses the featured image for an unmatched multi-variant item', () => {
  const unmatched = mapLineItemToDetailedItem(
    {
      id: 503,
      product_id: 100,
      variant_id: 9999,
      title: 'Classic Shoe',
      variant_title: 'Black / 40',
    },
    product
  );

  assert.equal(unmatched.imageUrl, '');
  assert.equal(unmatched.imageMatch, 'missing');
  assert.notEqual(unmatched.imageUrl, product.image.src);
});

test('never guesses a product image when a multi-variant line lacks variant_id', () => {
  const missingVariantIdentity = mapLineItemToDetailedItem(
    {
      id: 505,
      product_id: 100,
      title: 'Classic Shoe',
      image_url: 'https://cdn.example/beige.jpg',
    },
    product
  );

  assert.equal(missingVariantIdentity.variantId, '');
  assert.equal(missingVariantIdentity.imageUrl, '');
  assert.equal(missingVariantIdentity.imageMatch, 'missing');
});

test('uses image.variant_ids when Shopify omits variant.image_id', () => {
  const catalogProduct = {
    images: [
      {
        id: 33,
        src: 'https://cdn.example/navy.jpg',
        variant_ids: [3003],
      },
    ],
    variants: [{ id: 3003, title: 'Navy' }],
  };

  assert.deepEqual(resolveExactVariantImage(catalogProduct, '3003'), {
    url: 'https://cdn.example/navy.jpg',
    imageId: '33',
    match: 'image_variant_ids',
  });
});

test('accepts a product image only when the product has one variant', () => {
  const oneVariant = {
    image: { id: 44, src: 'https://cdn.example/only.jpg' },
    images: [{ id: 44, src: 'https://cdn.example/only.jpg' }],
    variants: [{ id: 4004, title: 'Default Title' }],
  };
  const multipleWithoutExactImage = {
    ...oneVariant,
    variants: [{ id: 4004 }, { id: 4005 }],
  };

  assert.equal(
    resolveExactVariantImage(oneVariant, '4004')?.url,
    'https://cdn.example/only.jpg'
  );
  assert.equal(resolveExactVariantImage(multipleWithoutExactImage, '4004'), null);
});

test('rejects a line-item image explicitly tied to another variant', () => {
  const mapped = mapLineItemToDetailedItem(
    {
      id: 504,
      product_id: 100,
      variant_id: 1002,
      title: 'Classic Shoe',
      image: {
        id: 10,
        src: 'https://cdn.example/beige.jpg',
        variant_ids: [1001],
      },
    },
    product
  );

  assert.equal(mapped.imageUrl, 'https://cdn.example/black.jpg');
  assert.equal(mapped.imageMatch, 'variant_image_id');
});
