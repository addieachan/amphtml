/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * 
 * 
 * 
 * Workers Thread
 */

import {BaseElement} from '../src/base-element';
import {isExperimentOn} from '../src/experiments';
import {isLayoutSizeDefined} from '../src/layout';
import {registerElement} from '../src/service/custom-element-registry';
import {srcsetFromElement, srcsetFromSrc} from '../src/srcset';

/**
 * Attributes to propagate to internal image when changed externally.
 * @type {!Array<string>}
 */
const ATTRIBUTES_TO_PROPAGATE = ['alt', 'title', 'referrerpolicy', 'aria-label',
  'aria-describedby', 'aria-labelledby'];

const EXPERIMENTAL_ATTRIBUTES_TO_PROPAGATE = ATTRIBUTES_TO_PROPAGATE
    .concat(['srcset', 'src', 'sizes']);

export class AmpImg extends BaseElement {

  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {boolean} */
    this.allowImgLoadFallback_ = true;

    /** @private {boolean} */
    this.isPrerenderAllowed_ = true;

    /** @private {?Element} */
    this.img_ = null;

    /** @private {?../src/srcset.Srcset} */
    this.srcset_ = null;

    /** @private @const {boolean} */
    this.useNativeSrcset_ = isExperimentOn(this.win, 'amp-img-native-srcset');
  }

  /** @override */
  mutatedAttributesCallback(mutations) {
    let mutated = false;
    if (!this.useNativeSrcset_) {
      if (mutations['srcset'] !== undefined) {
        // `srcset` mutations take precedence over `src` mutations.
        this.srcset_ = srcsetFromElement(this.element);
        mutated = true;
      } else if (mutations['src'] !== undefined) {
        // If only `src` is mutated, then ignore the existing `srcset` attribute
        // value (may be set automatically as cache optimization).
        this.srcset_ = srcsetFromSrc(this.element.getAttribute('src'));
        mutated = true;
      }
      // This element may not have been laid out yet.
      if (mutated && this.img_) {
        this.updateImageSrc_();
      }
    }

    if (this.img_) {
      const propAttrs = this.useNativeSrcset_ ?
        EXPERIMENTAL_ATTRIBUTES_TO_PROPAGATE :
        ATTRIBUTES_TO_PROPAGATE;
      const attrs = propAttrs.filter(
          value => mutations[value] !== undefined);
      this.propagateAttributes(
          attrs, this.img_, /* opt_removeMissingAttrs */ true);

      if (this.useNativeSrcset_) {
        this.guaranteeSrcForSrcsetUnsupportedBrowsers_();
      }

    }
  }

  /** @override */
  preconnectCallback(onLayout) {
    // NOTE(@wassgha): since parseSrcset is computationally expensive and can
    // not be inside the `buildCallback`, we went with preconnecting to the
    // `src` url if it exists or the first srcset url.
    const src = this.element.getAttribute('src');
    if (src) {
      this.preconnect.url(src, onLayout);
    } else {
      const srcset = this.element.getAttribute('srcset');
      if (!srcset) {
        return;
      }
      // We try to find the first url in the srcset
      const srcseturl = /https?:\/\/\S+/.exec(srcset);
      // Connect to the first url if it exists
      if (srcseturl) {
        this.preconnect.url(srcseturl[0], onLayout);
      }
    }
  }

  /** @override */
  buildCallback() {
    this.isPrerenderAllowed_ = !this.element.hasAttribute('noprerender');
  }

  /** @override */
  isLayoutSupported(layout) {
    return isLayoutSizeDefined(layout);
  }

  /**
   * Create the actual image element and set up instance variables.
   * Called lazily in the first `#layoutCallback`.
   */
  initialize_() {
    if (this.img_) {
      return;
    }
    if (!this.useNativeSrcset_ && !this.srcset_) {
      this.srcset_ = srcsetFromElement(this.element);
    }
    // If this amp-img IS the fallback then don't allow it to have its own
    // fallback to stop from nested fallback abuse.
    this.allowImgLoadFallback_ = !this.element.hasAttribute('fallback');

    // For inabox SSR, image will have been written directly to DOM so no need
    // to recreate.  Calling appendChild again will have no effect.
    if (this.element.hasAttribute('i-amphtml-ssr')) {
      this.img_ = this.element.querySelector('img');
    }
    this.img_ = this.img_ || new Image();
    this.img_.setAttribute('decoding', 'async');
    if (this.element.id) {
      this.img_.setAttribute('amp-img-id', this.element.id);
    }

    // Remove role=img otherwise this breaks screen-readers focus and
    // only read "Graphic" when using only 'alt'.
    if (this.element.getAttribute('role') == 'img') {
      this.element.removeAttribute('role');
      this.user().error(
          'AMP-IMG', 'Setting role=img on amp-img elements breaks ' +
        'screen readers please just set alt or ARIA attributes, they will ' +
        'be correctly propagated for the underlying <img> element.');
    }


    if (this.useNativeSrcset_) {
      this.propagateAttributes(EXPERIMENTAL_ATTRIBUTES_TO_PROPAGATE,
          this.img_);
      this.guaranteeSrcForSrcsetUnsupportedBrowsers_();
    } else {
      this.propagateAttributes(ATTRIBUTES_TO_PROPAGATE, this.img_);
    }

    this.applyFillContent(this.img_, true);

    this.element.appendChild(this.img_);
  }

  /** @override */
  prerenderAllowed() {
    return this.isPrerenderAllowed_;
  }

  /** @override */
  isRelayoutNeeded() {
    return true;
  }

  /** @override */
  reconstructWhenReparented() {
    return false;
  }

  /** @override */
  layoutCallback() {
    this.initialize_();
    let promise = this.updateImageSrc_();

    // We only allow to fallback on error on the initial layoutCallback
    // or else this would be pretty expensive.
    if (this.allowImgLoadFallback_) {
      promise = promise.catch(e => {
        this.onImgLoadingError_();
        throw e;
      });
      this.allowImgLoadFallback_ = false;
    }
    return promise;
  }

  /**
   * Sets the img src to the first url in the srcset if srcset is defined but
   * src is not.
   * @private
   */
  guaranteeSrcForSrcsetUnsupportedBrowsers_() {
    // The <img> tag does not have a src and does not support srcset
    if (!this.img_.hasAttribute('src') && 'srcset' in this.img_ == false) {
      const srcset = this.element.getAttribute('srcset');
      const matches = /\S+/.exec(srcset);
      if (matches == null) {
        return;
      }
      const srcseturl = matches[0];
      this.img_.setAttribute('src', srcseturl);
    }
  }

  /**
   * @return {!Promise}
   * @private
   */
  updateImageSrc_() {
    if (this.getLayoutWidth() <= 0) {
      return Promise.resolve();
    }

    if (!this.useNativeSrcset_) {
      const src = this.srcset_.select(
          // The width should never be 0, but we fall back to the screen width
          // just in case.
          this.getViewport().getWidth() || this.win.screen.width,
          this.getDpr());
          const palette = this.element.getAttribute('low-res').replace(/\s+/, ' ').split(' ')
          .reduce((acc, p) => {
            if (p.match(/([a-z0-9]{6})/)) {
              acc.push(p);
            }
            return acc;
          }, []);
      const whenImageLoaded = loadPromise(createImg(src));

      if (src == this.img_.getAttribute('src')) {
        return Promise.resolve();
      }

      this.img_.setAttribute('src', src);
      const {hash} = window.location;
    const loadingPlaceholder =
          blurWithWorker(whenImageLoaded,200, 200, palette);
          //blurWithPainter(whenImageLoaded, palette);
    this.element.appendChild(loadingPlaceholder);
    
    const loadingIndicator = createLoadingIndicator();
    this.element.appendChild(loadingIndicator);
    
    const container = createImgContainer(src);  
    this.element.appendChild(container);
    
    whenImageLoaded.then(() => {  
      requestAnimationFrame(() => {
        container.style.setProperty('opacity', '1', 'important');
        loadingIndicator.remove();
      });
    });
    }

    return this.loadPromise(this.img_).then(() => {
      // Clean up the fallback if the src has changed.
      if (!this.allowImgLoadFallback_ &&
          this.img_.classList.contains('i-amphtml-ghost')) {
        this.getVsync().mutate(() => {
          this.img_.classList.remove('i-amphtml-ghost');
          this.toggleFallback(false);
        });
      }
    });
  }

  /**
   * If the image fails to load, show a placeholder instead.
   * @private
   */
  onImgLoadingError_() {
    this.getVsync().mutate(() => {
      this.img_.classList.add('i-amphtml-ghost');
      this.toggleFallback(true);
      // Hide placeholders, as browsers that don't support webp
      // Would show the placeholder underneath a transparent fallback
      this.togglePlaceholder(false);
    });
  }
}

/**
 * @param {!Window} win Destination window for the new element.
 * @this {undefined}  // Make linter happy
 */
export function installImg(win) {
  registerElement(win, 'amp-img', AmpImg);
}

// Used code form Alan Orozco from: https://glitch.com/edit/#!/laser-knife?path=demo.js:1:0 
const THROTTLE = 1200;

const WORKER = `
/*

StackBlur - a fast almost Gaussian Blur For Canvas

Version: 	0.5
Author:		Mario Klingemann
Contact: 	mario@quasimondo.com
Website:	http://www.quasimondo.com/StackBlurForCanvas
Twitter:	@quasimondo

In case you find this class useful - especially in commercial projects -
I am not totally unhappy for a small donation to my PayPal account
mario@quasimondo.de

Or support me on flattr: 
https://flattr.com/thing/72791/StackBlur-a-fast-almost-Gaussian-Blur-Effect-for-CanvasJavascript

Copyright (c) 2010 Mario Klingemann

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
*/
var mul_table = [
    512,512,456,512,328,456,335,512,405,328,271,456,388,335,292,512,
    454,405,364,328,298,271,496,456,420,388,360,335,312,292,273,512,
    482,454,428,405,383,364,345,328,312,298,284,271,259,496,475,456,
    437,420,404,388,374,360,347,335,323,312,302,292,282,273,265,512,
    497,482,468,454,441,428,417,405,394,383,373,364,354,345,337,328,
    320,312,305,298,291,284,278,271,265,259,507,496,485,475,465,456,
    446,437,428,420,412,404,396,388,381,374,367,360,354,347,341,335,
    329,323,318,312,307,302,297,292,287,282,278,273,269,265,261,512,
    505,497,489,482,475,468,461,454,447,441,435,428,422,417,411,405,
    399,394,389,383,378,373,368,364,359,354,350,345,341,337,332,328,
    324,320,316,312,309,305,301,298,294,291,287,284,281,278,274,271,
    268,265,262,259,257,507,501,496,491,485,480,475,470,465,460,456,
    451,446,442,437,433,428,424,420,416,412,408,404,400,396,392,388,
    385,381,377,374,370,367,363,360,357,354,350,347,344,341,338,335,
    332,329,326,323,320,318,315,312,310,307,304,302,299,297,294,292,
    289,287,285,282,280,278,275,273,271,269,267,265,263,261,259];


var shg_table = [
       9, 11, 12, 13, 13, 14, 14, 15, 15, 15, 15, 16, 16, 16, 16, 17, 
    17, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19, 
    19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 20, 20, 20,
    20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22, 
    22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22,
    22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 23, 
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 
    23, 23, 23, 23, 23, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24 ];


function stackBlurCanvasRGB(width, height, pixels, radius) {
  var x, y, i, p, yp, yi, yw, r_sum, g_sum, b_sum,
  r_out_sum, g_out_sum, b_out_sum,
  r_in_sum, g_in_sum, b_in_sum,
  pr, pg, pb, rbs;

  var div = radius + radius + 1;
  var w4 = width << 2;
  var widthMinus1  = width - 1;
  var heightMinus1 = height - 1;
  var radiusPlus1  = radius + 1;
  var sumFactor = radiusPlus1 * ( radiusPlus1 + 1 ) / 2;

  var stackStart = new BlurStack();
  var stack = stackStart;
  for ( i = 1; i < div; i++ )
  {
    stack = stack.next = new BlurStack();
    if ( i == radiusPlus1 ) var stackEnd = stack;
  }
  stack.next = stackStart;
  var stackIn = null;
  var stackOut = null;

  yw = yi = 0;

  var mul_sum = mul_table[radius];
  var shg_sum = shg_table[radius];

  for ( y = 0; y < height; y++ )
  {
    r_in_sum = g_in_sum = b_in_sum = r_sum = g_sum = b_sum = 0;

    r_out_sum = radiusPlus1 * ( pr = pixels[yi] );
    g_out_sum = radiusPlus1 * ( pg = pixels[yi+1] );
    b_out_sum = radiusPlus1 * ( pb = pixels[yi+2] );

    r_sum += sumFactor * pr;
    g_sum += sumFactor * pg;
    b_sum += sumFactor * pb;

    stack = stackStart;

    for( i = 0; i < radiusPlus1; i++ )
    {
      stack.r = pr;
      stack.g = pg;
      stack.b = pb;
      stack = stack.next;
    }

    for( i = 1; i < radiusPlus1; i++ )
    {
      p = yi + (( widthMinus1 < i ? widthMinus1 : i ) << 2 );
      r_sum += ( stack.r = ( pr = pixels[p])) * ( rbs = radiusPlus1 - i );
      g_sum += ( stack.g = ( pg = pixels[p+1])) * rbs;
      b_sum += ( stack.b = ( pb = pixels[p+2])) * rbs;

      r_in_sum += pr;
      g_in_sum += pg;
      b_in_sum += pb;

      stack = stack.next;
    }


    stackIn = stackStart;
    stackOut = stackEnd;
    for ( x = 0; x < width; x++ )
    {
      pixels[yi]   = (r_sum * mul_sum) >> shg_sum;
      pixels[yi+1] = (g_sum * mul_sum) >> shg_sum;
      pixels[yi+2] = (b_sum * mul_sum) >> shg_sum;

      r_sum -= r_out_sum;
      g_sum -= g_out_sum;
      b_sum -= b_out_sum;

      r_out_sum -= stackIn.r;
      g_out_sum -= stackIn.g;
      b_out_sum -= stackIn.b;

      p =  ( yw + ( ( p = x + radius + 1 ) < widthMinus1 ? p : widthMinus1 ) ) << 2;

      r_in_sum += ( stackIn.r = pixels[p]);
      g_in_sum += ( stackIn.g = pixels[p+1]);
      b_in_sum += ( stackIn.b = pixels[p+2]);

      r_sum += r_in_sum;
      g_sum += g_in_sum;
      b_sum += b_in_sum;

      stackIn = stackIn.next;

      r_out_sum += ( pr = stackOut.r );
      g_out_sum += ( pg = stackOut.g );
      b_out_sum += ( pb = stackOut.b );

      r_in_sum -= pr;
      g_in_sum -= pg;
      b_in_sum -= pb;

      stackOut = stackOut.next;

      yi += 4;
    }
    yw += width;
  }


  for ( x = 0; x < width; x++ )
  {
    g_in_sum = b_in_sum = r_in_sum = g_sum = b_sum = r_sum = 0;

    yi = x << 2;
    r_out_sum = radiusPlus1 * ( pr = pixels[yi]);
    g_out_sum = radiusPlus1 * ( pg = pixels[yi+1]);
    b_out_sum = radiusPlus1 * ( pb = pixels[yi+2]);

    r_sum += sumFactor * pr;
    g_sum += sumFactor * pg;
    b_sum += sumFactor * pb;

    stack = stackStart;

    for( i = 0; i < radiusPlus1; i++ )
    {
      stack.r = pr;
      stack.g = pg;
      stack.b = pb;
      stack = stack.next;
    }

    yp = width;

    for( i = 1; i <= radius; i++ )
    {
      yi = ( yp + x ) << 2;

      r_sum += ( stack.r = ( pr = pixels[yi])) * ( rbs = radiusPlus1 - i );
      g_sum += ( stack.g = ( pg = pixels[yi+1])) * rbs;
      b_sum += ( stack.b = ( pb = pixels[yi+2])) * rbs;

      r_in_sum += pr;
      g_in_sum += pg;
      b_in_sum += pb;

      stack = stack.next;

      if( i < heightMinus1 )
      {
        yp += width;
      }
    }

    yi = x;
    stackIn = stackStart;
    stackOut = stackEnd;
    for ( y = 0; y < height; y++ )
    {
      p = yi << 2;
      pixels[p]   = (r_sum * mul_sum) >> shg_sum;
      pixels[p+1] = (g_sum * mul_sum) >> shg_sum;
      pixels[p+2] = (b_sum * mul_sum) >> shg_sum;

      r_sum -= r_out_sum;
      g_sum -= g_out_sum;
      b_sum -= b_out_sum;

      r_out_sum -= stackIn.r;
      g_out_sum -= stackIn.g;
      b_out_sum -= stackIn.b;

      p = ( x + (( ( p = y + radiusPlus1) < heightMinus1 ? p : heightMinus1 ) * width )) << 2;

      r_sum += ( r_in_sum += ( stackIn.r = pixels[p]));
      g_sum += ( g_in_sum += ( stackIn.g = pixels[p+1]));
      b_sum += ( b_in_sum += ( stackIn.b = pixels[p+2]));

      stackIn = stackIn.next;

      r_out_sum += ( pr = stackOut.r );
      g_out_sum += ( pg = stackOut.g );
      b_out_sum += ( pb = stackOut.b );

      r_in_sum -= pr;
      g_in_sum -= pg;
      b_in_sum -= pb;

      stackOut = stackOut.next;

      yi += width;
    }
  }
}

function BlurStack()
{
  this.r = 0;
  this.g = 0;
  this.b = 0;
  this.a = 0;
  this.next = null;
}

self.onmessage = function (e) {
  const {data, width, height, id} = e.data;
  const radius = Math.round(width / 4);
  stackBlurCanvasRGB(width, height, data.data, radius);
  self.postMessage({data, id});
};

`;



function assert(truthy) {
  if (!truthy) {
    console.error('Assertion failed');
  }
}

function sourceToUri(sourceText) {
  const createObjectURL = (self.URL || self.webkitURL || {}).createObjectURL || function(){};
  const sourceBlob = new Blob([sourceText], {type: 'application/javascript'});
  return createObjectURL(sourceBlob);
}


let worker;
function getWorker() {
  if (worker) {
    return worker;
  }
  const sourceUri = sourceToUri(WORKER);
  
  worker = new Worker(sourceUri);

  worker.onmessage = e => {
    const {data, id} = e.data;
    const canvas = document.getElementById(id);
    const context = canvas.getContext("2d");
    context.putImageData(data, 0, 0);
    canvas.style.opacity = 1;
  };

  return worker;
}




function blurWithWorker(loadPromise, width, height, pixels) {
  const worker = getWorker();
  const aspect = width / height;
  
  const reducedWidth = 100;
  const reducedHeight = Math.floor(reducedWidth / aspect);

  const dim = Math.sqrt(pixels.length);
  
  const canvas = document.createElement('canvas');
    
  canvas.id = 'i-amphtml-c-' + Date.now();

  canvas.classList.add('i-amphtml-fill-content');
  
  canvas.width = reducedWidth;
  canvas.height = reducedHeight;
  
  assert(dim % 1 == 0);
	
	const context = canvas.getContext("2d");

  canvas.style.opacity = '0';
  
  const rawWidth = reducedWidth / dim;
  const rawHeight = reducedHeight / dim;
  
  context.fillStyle = '#' + pixels[Math.floor(pixels / 2)];
  context.fillRect(0, 0, width, height);
  
  for (let i = 0, p = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++, p++) {
      const width = i == 0 ? Math.ceil(rawWidth) : Math.floor(rawWidth);
      const height = j == 0 ? Math.ceil(rawHeight) : Math.floor(rawHeight);
      const x = j == 1 ? Math.ceil(j * rawWidth) : Math.floor(j * rawWidth);
      const y = i == 1 ? Math.ceil(i * rawHeight) : Math.floor(i * rawHeight);
      
      context.fillStyle = '#' + pixels[p].trim();
      context.fillRect(x, y, width, height);
    }
  }
			
	try {
    const data = context.getImageData(0, 0, reducedWidth, reducedHeight);
    const {id} = canvas;
    worker.postMessage({data, width: reducedWidth, height: reducedHeight, id});
	} catch(e) {
	  alert("Cannot access image");
	  throw new Error("unable to access image data: " + e);
	}
  
  loadPromise.then(() => {
    canvas.style.setProperty('opacity', '1');
    setTimeout(() => {
      canvas.remove();
    }, 500);
  });
  
  return canvas;
}




function loadPromise(el) {
  const throttle = THROTTLE + Math.floor(Math.random() * THROTTLE);
  return new Promise(resolve => {
    const start = Date.now();
    el.onload = () => {
      const time = Math.max(0, throttle - (Date.now() - start));
      setTimeout(() => resolve(el), time);
    };
  });
}

function createImg(src) {
  const img = new Image;
  img.src = src;
  return img;
}

function html(str) {
  const el = document.createElement('div');
  el.innerHTML = str;
  return el.firstElementChild;
}


function createLoadingIndicator() {
  return html('<ul id="loading-indicator"><li></li><li class="two"></li><li class="three"></li></ul>');
}


function createSizer(aspect) {
  const el = html('<div class="sizer"></div>');
  el.style.paddingTop = ((1 / aspect) * 100) + '%';
  return el;
}

function createImgContainer(src) {
  const el = html('<div class="img i-amphtml-fill-content"></div>');
  el.style.backgroundImage = 'url(' + src + ')';
  return el;
}